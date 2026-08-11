mod commands;
mod error;
mod funded_cleanup;
mod keys;
mod menubar;
mod rpc;
mod settings;
mod stake;
mod state;
mod sweep;
mod tokens;
mod validators;
mod vault;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// Build the menu bar item and give it the last known total straight away, so
/// the number is on screen before the window has even opened.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show LocalWallet", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh balances", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &refresh, &quit])?;

    let settings = app
        .path()
        .app_data_dir()
        .map(|dir| settings::load(&dir))
        .unwrap_or_default();

    // Only read the cached total when the feature is on, so a disabled menu
    // bar never surfaces holdings even if a stale file is lying around.
    let title = if settings.menubar {
        app.path()
            .app_data_dir()
            .ok()
            .and_then(|dir| menubar::cached_title(&dir))
    } else {
        None
    };

    let mut builder = TrayIconBuilder::with_id(menubar::TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true);
    if let Some(title) = title {
        builder = builder.title(title);
    }

    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            // The frontend owns the wallet list, so it does the refreshing.
            "refresh" => {
                let _ = app.emit(commands::MENUBAR_REFRESH_EVENT, ());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
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
            commands::menubar_update,
            commands::menubar_clear,
            commands::rpc_test,
            commands::tokens_scan,
            commands::cleanup_preview,
            commands::cleanup_run,
            commands::funded_cleanup_preview,
            commands::funded_cleanup_run,
            commands::send_quote,
            commands::send_sol,
            commands::sweep_preview,
            commands::stake_scan,
            commands::stake_quote,
            commands::stake_delegate,
            commands::stake_deactivate,
            commands::stake_withdraw,
            commands::validators_list,
            commands::sweep_run,
        ])
        // Closing the window hides it instead of quitting: the menu bar total
        // is the point of staying resident. Quit is deliberate — the tray's
        // Quit item, or Cmd+Q.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The dock icon stays visible while the window is hidden, so
            // clicking it has to bring the window back. Without this the app
            // looks unresponsive to a dock click.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            // Silence unused-variable warnings on non-macOS targets.
            let _ = (app, event);
        });
}
