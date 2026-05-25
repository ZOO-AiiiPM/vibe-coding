// 订阅区 commands —— rusqlite + adapter::fetch_one 集成
//
// 业务逻辑迁移自老 lib/subscription.ts（worktree 时代是前端 d.execute SQL）。
// 现在统一到「前端只 invoke / Rust 端做 db CRUD + 网络」的架构。
//
// async + Mutex<Connection> 配合：connection guard 不能跨 await（rusqlite Connection 非 Send），
// 所以 lock 总是在 scope `{ }` 里使用，await 之前 drop。

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::db::Db;
use crate::subscription::adapter::{self, FetchOutcome, FetchedEntry, FetchedFeedMeta};

const FAILURE_THRESHOLD: i32 = 3;

// ── DTO ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct Source {
    pub id: i64,
    pub feed_url: String,
    pub title: String,
    pub description: String,
    pub site_url: Option<String>,
    pub favicon_url: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_content_hash: Option<String>,
    pub last_fetched_at: Option<i64>,
    pub consecutive_failure_count: i32,
    pub status: String,
    pub status_detail: Option<String>,
    pub added_at: i64,
    /// list_sources_with_unread 才填，其它路径为 0
    pub unread_count: i64,
}

#[derive(Debug, Serialize)]
pub struct Entry {
    pub id: i64,
    pub source_id: i64,
    pub guid: String,
    pub title: String,
    pub content_html: String,
    pub excerpt: String,
    pub link: Option<String>,
    pub author: String,
    pub published_at: Option<i64>,
    pub fetched_at: i64,
    pub read_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct AddResult {
    pub source: Source,
    pub entries_inserted: i64,
}

#[derive(Debug, Serialize, Default)]
pub struct RefreshSummary {
    pub total: i64,
    pub success: i64,
    pub failed: i64,
    pub skipped_304: i64,
    pub new_entries: i64,
    pub started_at: i64,
    pub finished_at: i64,
}

// ── helpers（同步，要在 lock scope 内调）─────────────────────────────────

fn row_to_source(row: &rusqlite::Row) -> rusqlite::Result<Source> {
    Ok(Source {
        id: row.get("id")?,
        feed_url: row.get("feed_url")?,
        title: row.get("title")?,
        description: row.get("description")?,
        site_url: row.get("site_url")?,
        favicon_url: row.get("favicon_url")?,
        etag: row.get("etag")?,
        last_modified: row.get("last_modified")?,
        last_content_hash: row.get("last_content_hash")?,
        last_fetched_at: row.get("last_fetched_at")?,
        consecutive_failure_count: row.get("consecutive_failure_count")?,
        status: row.get("status")?,
        status_detail: row.get("status_detail")?,
        added_at: row.get("added_at")?,
        unread_count: 0,
    })
}

fn fetch_source_by_id(conn: &Connection, id: i64) -> Result<Source, String> {
    conn.query_row(
        "SELECT * FROM subscription_sources WHERE id = ?1",
        params![id],
        row_to_source,
    )
    .map_err(|e| format!("DB_ERROR: {}", e))
}

fn insert_entries(
    tx: &rusqlite::Transaction,
    source_id: i64,
    entries: &[FetchedEntry],
) -> Result<i64, String> {
    let mut inserted = 0i64;
    for e in entries {
        let n = tx
            .execute(
                "INSERT OR IGNORE INTO feed_entries
                 (source_id, guid, title, content_html, excerpt, link, author, published_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    source_id,
                    e.guid,
                    e.title,
                    e.content_html,
                    e.excerpt,
                    e.link,
                    e.author,
                    e.published_at
                ],
            )
            .map_err(|err| format!("DB_ERROR: {}", err))?;
        if n > 0 {
            inserted += 1;
        }
    }
    Ok(inserted)
}

/// fetch 成功后更新 source 元信息 + last_fetched_at + 重置 failure
fn mark_source_fetched_ok(
    conn: &Connection,
    id: i64,
    feed_meta: Option<&FetchedFeedMeta>,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<(), String> {
    if let Some(m) = feed_meta {
        conn.execute(
            "UPDATE subscription_sources SET
                title = CASE WHEN ?1 != '' THEN ?1 ELSE title END,
                description = CASE WHEN ?2 != '' THEN ?2 ELSE description END,
                site_url = COALESCE(?3, site_url),
                favicon_url = COALESCE(?4, favicon_url),
                etag = ?5,
                last_modified = ?6,
                status = 'ok',
                status_detail = NULL,
                consecutive_failure_count = 0,
                last_fetched_at = unixepoch()
             WHERE id = ?7",
            params![
                m.title,
                m.description,
                m.site_url,
                m.favicon_url,
                etag,
                last_modified,
                id
            ],
        )
        .map_err(|e| format!("DB_ERROR: {}", e))?;
    } else {
        // not_modified 路径：只刷 last_fetched_at + 重置 failure
        conn.execute(
            "UPDATE subscription_sources SET
                status = 'ok',
                status_detail = NULL,
                consecutive_failure_count = 0,
                last_fetched_at = unixepoch()
             WHERE id = ?1",
            params![id],
        )
        .map_err(|e| format!("DB_ERROR: {}", e))?;
    }
    Ok(())
}

/// 失败时累加 failure_count，到阈值标 unhealthy
fn record_source_failure(conn: &Connection, id: i64, error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE subscription_sources SET
            consecutive_failure_count = consecutive_failure_count + 1,
            status_detail = ?1,
            last_fetched_at = unixepoch()
         WHERE id = ?2",
        params![error, id],
    )
    .map_err(|e| format!("DB_ERROR: {}", e))?;

    let count: i32 = conn
        .query_row(
            "SELECT consecutive_failure_count FROM subscription_sources WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| format!("DB_ERROR: {}", e))?;

    if count >= FAILURE_THRESHOLD {
        conn.execute(
            "UPDATE subscription_sources SET status = 'unhealthy' WHERE id = ?1",
            params![id],
        )
        .map_err(|e| format!("DB_ERROR: {}", e))?;
    }
    Ok(())
}

fn hostname_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|s| s.split('/').next())
        .map(|s| s.trim_start_matches("www.").to_string())
        .unwrap_or_else(|| url.to_string())
}

fn validate_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("INVALID_URL: empty".to_string());
    }
    let lower = trimmed.to_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("INVALID_URL: only http/https supported".to_string());
    }
    Ok(trimmed.to_string())
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn add_subscription(db: State<'_, Db>, url: String) -> Result<AddResult, String> {
    let feed_url = validate_url(&url)?;

    // 重复检测（短 lock）
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM subscription_sources WHERE feed_url = ?1",
                params![feed_url],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if exists {
            return Err("DUPLICATE_URL".to_string());
        }
    }

    // 抓取（async，no lock）
    let outcome = adapter::fetch_one(&feed_url, None, None)
        .await
        .map_err(|e| format!("FETCH_FAILED: {}", e))?;

    let (feed_meta, entries, etag, last_modified) = match outcome {
        FetchOutcome::Updated {
            feed_meta,
            entries,
            etag,
            last_modified,
        } => (feed_meta, entries, etag, last_modified),
        FetchOutcome::NotModified => {
            return Err("EMPTY_RESPONSE: 首次抓取拿到 304，换一个 RSS 源试试".to_string());
        }
    };

    let title = if feed_meta.title.trim().is_empty() {
        hostname_of(&feed_url)
    } else {
        feed_meta.title.clone()
    };

    // INSERT source + entries（短 lock，事务）
    let (source, entries_inserted) = {
        let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| format!("DB_ERROR: {}", e))?;

        tx.execute(
            "INSERT INTO subscription_sources
             (feed_url, title, description, site_url, favicon_url, etag, last_modified, status, last_fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ok', unixepoch())",
            params![
                feed_url,
                title,
                feed_meta.description,
                feed_meta.site_url,
                feed_meta.favicon_url,
                etag,
                last_modified
            ],
        )
        .map_err(|e| format!("DB_ERROR: {}", e))?;
        let source_id = tx.last_insert_rowid();

        let inserted = insert_entries(&tx, source_id, &entries)?;
        tx.commit().map_err(|e| format!("DB_ERROR: {}", e))?;

        let source = fetch_source_by_id(&conn, source_id)?;
        (source, inserted)
    };

    Ok(AddResult {
        source,
        entries_inserted,
    })
}

#[tauri::command]
pub fn list_sources_with_unread(db: State<'_, Db>) -> Result<Vec<Source>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT s.*,
                    COALESCE(SUM(CASE WHEN e.read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread_count
             FROM subscription_sources s
             LEFT JOIN feed_entries e ON e.source_id = s.id
             GROUP BY s.id
             ORDER BY COALESCE(s.last_fetched_at, s.added_at) DESC",
        )
        .map_err(|e| format!("DB_ERROR: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let mut s = row_to_source(row)?;
            s.unread_count = row.get("unread_count")?;
            Ok(s)
        })
        .map_err(|e| format!("DB_ERROR: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DB_ERROR: {}", e))
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_entries_for_source(db: State<'_, Db>, source_id: i64) -> Result<Vec<Entry>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, source_id, guid, title, content_html, excerpt, link, author,
                    published_at, fetched_at, read_at
             FROM feed_entries
             WHERE source_id = ?1
             ORDER BY COALESCE(published_at, fetched_at) DESC",
        )
        .map_err(|e| format!("DB_ERROR: {}", e))?;

    let rows = stmt
        .query_map(params![source_id], |row| {
            Ok(Entry {
                id: row.get(0)?,
                source_id: row.get(1)?,
                guid: row.get(2)?,
                title: row.get(3)?,
                content_html: row.get(4)?,
                excerpt: row.get(5)?,
                link: row.get(6)?,
                author: row.get(7)?,
                published_at: row.get(8)?,
                fetched_at: row.get(9)?,
                read_at: row.get(10)?,
            })
        })
        .map_err(|e| format!("DB_ERROR: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DB_ERROR: {}", e))
}

#[tauri::command(rename_all = "snake_case")]
pub fn mark_entry_read(db: State<'_, Db>, entry_id: i64) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE feed_entries SET read_at = unixepoch() WHERE id = ?1 AND read_at IS NULL",
        params![entry_id],
    )
    .map_err(|e| format!("DB_ERROR: {}", e))?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn delete_source(db: State<'_, Db>, source_id: i64) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    // ON DELETE CASCADE 自动删 entries
    conn.execute(
        "DELETE FROM subscription_sources WHERE id = ?1",
        params![source_id],
    )
    .map_err(|e| format!("DB_ERROR: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn refresh_all_subscriptions(db: State<'_, Db>) -> Result<RefreshSummary, String> {
    let started_at = chrono_now();

    // 列出所有 source（短 lock）
    let sources: Vec<Source> = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT * FROM subscription_sources
                 ORDER BY COALESCE(last_fetched_at, added_at) DESC",
            )
            .map_err(|e| format!("DB_ERROR: {}", e))?;
        let rows = stmt
            .query_map([], row_to_source)
            .map_err(|e| format!("DB_ERROR: {}", e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("DB_ERROR: {}", e))?
    };

    let mut summary = RefreshSummary {
        total: sources.len() as i64,
        started_at,
        ..Default::default()
    };

    for s in &sources {
        // 旧 source 还没有 favicon 时强制走 200（不发条件请求），让 metadata 能补全
        let use_conditional = s.favicon_url.is_some();
        let if_none_match = if use_conditional {
            s.etag.as_deref()
        } else {
            None
        };
        let if_modified_since = if use_conditional {
            s.last_modified.as_deref()
        } else {
            None
        };

        let result = adapter::fetch_one(&s.feed_url, if_none_match, if_modified_since).await;

        match result {
            Ok(FetchOutcome::NotModified) => {
                // 仅刷 last_fetched_at + 重置 failure
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                if let Err(e) = mark_source_fetched_ok(&conn, s.id, None, None, None) {
                    eprintln!("[refresh] mark ok failed for {}: {}", s.id, e);
                }
                summary.skipped_304 += 1;
                summary.success += 1;
            }
            Ok(FetchOutcome::Updated {
                feed_meta,
                entries,
                etag,
                last_modified,
            }) => {
                let inserted = {
                    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
                    let tx = conn.transaction().map_err(|e| format!("DB_ERROR: {}", e))?;
                    let inserted = insert_entries(&tx, s.id, &entries)?;
                    tx.commit().map_err(|e| format!("DB_ERROR: {}", e))?;
                    inserted
                };

                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                if let Err(e) = mark_source_fetched_ok(
                    &conn,
                    s.id,
                    Some(&feed_meta),
                    etag.as_deref(),
                    last_modified.as_deref(),
                ) {
                    eprintln!("[refresh] mark ok failed for {}: {}", s.id, e);
                }
                summary.new_entries += inserted;
                summary.success += 1;
            }
            Err(err_msg) => {
                let conn = db.conn.lock().map_err(|e| e.to_string())?;
                if let Err(e) = record_source_failure(&conn, s.id, &err_msg) {
                    eprintln!("[refresh] record failure failed for {}: {}", s.id, e);
                }
                summary.failed += 1;
            }
        }
    }

    summary.finished_at = chrono_now();
    Ok(summary)
}

#[tauri::command]
pub fn should_auto_refresh_on_startup(db: State<'_, Db>) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let max_ts: Option<i64> = conn
        .query_row(
            "SELECT MAX(last_fetched_at) FROM subscription_sources",
            [],
            |r| r.get(0),
        )
        .unwrap_or(None);

    let max_ts = match max_ts {
        Some(t) if t > 0 => t,
        _ => return Ok(true), // 从未抓过 → 该抓一次
    };

    // 比较年月日（用 unixepoch 算 day 数）
    let now = chrono_now();
    let secs_per_day: i64 = 24 * 60 * 60;
    let last_day = max_ts / secs_per_day;
    let today = now / secs_per_day;
    Ok(last_day != today)
}

/// 当前 unix 秒（不引入 chrono crate，用 std::time::SystemTime）
fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
