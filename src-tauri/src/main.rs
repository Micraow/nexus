use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
struct StorageInfo {
    data_dir: String,
    database_path: String,
    config_path: String,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    fs::create_dir_all(&path).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(path)
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("nexus.db"))
}

/// Resolve the active database location, honouring an optional user-configured
/// override from `storage.database_path`. Relative overrides live inside the
/// app data directory; absolute paths are used verbatim.
fn resolve_database_path(app: &AppHandle, custom_path: Option<String>) -> Result<PathBuf, String> {
    let configured = match custom_path {
        Some(value) => value,
        None => return database_path(app),
    };
    let trimmed = configured.trim().to_string();
    if trimmed.is_empty() {
        return database_path(app);
    }
    let candidate = PathBuf::from(&trimmed);
    if candidate.is_absolute() {
        Ok(candidate)
    } else {
        Ok(data_dir(app)?.join(candidate))
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("config.yaml"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标文件没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建目标目录：{error}"))?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|error| format!("写入临时文件失败：{error}"))?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("原子替换文件失败：{error}"));
    }
    Ok(())
}

fn timestamp_suffix() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

#[cfg(target_os = "linux")]
fn configure_input_method() {
    // WebKitGTK reads these variables before the window is created. Preserve
    // an explicit user choice, while making the common KDE + fcitx5 setup work
    // when Nexus is launched from a desktop shortcut.
    for (key, value) in [
        ("GTK_IM_MODULE", "fcitx"),
        ("QT_IM_MODULE", "fcitx"),
        ("XMODIFIERS", "@im=fcitx"),
    ] {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_input_method() {}

#[tauri::command]
fn storage_info(app: AppHandle, custom_path: Option<String>) -> Result<StorageInfo, String> {
    let data = data_dir(&app)?;
    let database = resolve_database_path(&app, custom_path)?;
    Ok(StorageInfo {
        data_dir: data.to_string_lossy().into_owned(),
        database_path: database.to_string_lossy().into_owned(),
        config_path: data.join("config.yaml").to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn read_database(app: AppHandle, custom_path: Option<String>) -> Result<Option<String>, String> {
    let path = resolve_database_path(&app, custom_path)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|error| format!("读取 nexus.db 失败：{error}"))?;
    Ok(Some(STANDARD.encode(bytes)))
}

#[tauri::command]
fn write_database(app: AppHandle, encoded: String, custom_path: Option<String>) -> Result<(), String> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("数据库字节流无效：{error}"))?;
    write_atomic(&resolve_database_path(&app, custom_path)?, &bytes)
}

#[tauri::command]
fn backup_database(app: AppHandle, custom_path: Option<String>) -> Result<Option<String>, String> {
    let source = resolve_database_path(&app, custom_path)?;
    if !source.exists() {
        return Ok(None);
    }
    let file_name = source
        .file_name()
        .map(|name| format!("{}.bak-{}", name.to_string_lossy(), timestamp_suffix()))
        .unwrap_or_else(|| format!("nexus.db.bak-{}", timestamp_suffix()));
    let backup = source.with_file_name(file_name);
    fs::copy(&source, &backup).map_err(|error| format!("备份 nexus.db 失败：{error}"))?;
    Ok(Some(backup.to_string_lossy().into_owned()))
}

#[tauri::command]
fn restore_database_backup(app: AppHandle, path: String, custom_path: Option<String>) -> Result<(), String> {
    let candidate = PathBuf::from(path);
    let data = fs::read(&candidate).map_err(|error| format!("读取数据库备份失败：{error}"))?;
    write_atomic(&resolve_database_path(&app, custom_path)?, &data)
}

#[tauri::command]
fn read_config(app: AppHandle) -> Result<Option<String>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("读取 config.yaml 失败：{error}"))
}

#[tauri::command]
fn write_config(app: AppHandle, content: String) -> Result<(), String> {
    write_atomic(&config_path(&app)?, content.as_bytes())
}

#[tauri::command]
fn list_system_fonts() -> Result<Vec<String>, String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    let families = database
        .faces()
        .flat_map(|face| face.families.iter().map(|(family, _)| family.trim()))
        .filter(|family| !family.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();
    Ok(families.into_iter().collect())
}

fn main() {
    configure_input_method();
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            storage_info,
            read_database,
            write_database,
            backup_database,
            restore_database_backup,
            read_config,
            write_config,
            list_system_fonts
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexus Weave");
}
