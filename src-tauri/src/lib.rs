mod commands;
mod error;
mod funded_cleanup;
mod keys;
mod rpc;
mod settings;
mod state;
mod sweep;
mod tokens;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_change_password,
            commands::vault_export,
            commands::wallets_list,
            commands::wallets_import,
            commands::wallets_remove,
            commands::wallets_rename,
            commands::balances_refresh,
            commands::settings_get,
            commands::settings_set,
            commands::rpc_test,
            commands::tokens_scan,
            commands::cleanup_preview,
            commands::cleanup_run,
            commands::funded_cleanup_preview,
            commands::funded_cleanup_run,
            commands::send_quote,
            commands::send_sol,
            commands::sweep_preview,
            commands::sweep_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
