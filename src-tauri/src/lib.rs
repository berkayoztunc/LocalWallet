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
use tauri::{AppHandle, Emitter, Manager};

/// The two menu items that change at runtime.
///
/// `TrayIcon` exposes no getter for its menu, so the handles are kept in
/// managed state instead of being looked up again later.
pub struct TrayMenu {
    pub status: MenuItem<tauri::Wry>,
    pub refresh: MenuItem<tauri::Wry>,
}

/// Set the status line at the top of the tray menu.
fn set_status(app: &AppHandle, status: &menubar::Status) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu.status.set_text(menubar::status_line(status));
    }
}

/// Reflect the vault's lock state in the menu.
///
/// A locked vault has an encrypted wallet list, so there is nothing to refresh.
/// Greying the item out and saying why beats offering an action that silently
/// does nothing.
pub fn sync_menu(app: &AppHandle) {
    let unlocked = app.state::<state::AppState>().is_unlocked();
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu.refresh.set_enabled(unlocked);
        let _ = menu.refresh.set_text(if unlocked {
            menubar::REFRESH_LABEL
        } else {
            menubar::REFRESH_LOCKED_LABEL
        });
    }
}

/// Refresh balances and update the menu bar, without touching the window.
///
/// The wallet list lives in `AppState`, not the webview, so this runs whether
/// the window is open, hidden or never shown. That is the entire point: the
/// tray used to route through the frontend and force the window open.
async fn refresh_from_tray(app: AppHandle) {
    let previous = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| menubar::load(&dir))
        .map(|c| c.updated_at);

    set_status(&app, &menubar::Status::Updating);

    let state = app.state::<state::AppState>();
    let balances = match commands::wallet_balances(&app, &state).await {
        Ok(b) => b,
        Err(e) => {
            set_status(
                &app,
                &menubar::Status::Failed {
                    reason: e.to_string(),
                    last_success: previous,
                },
            );
            return;
        }
    };

    let total: u64 = balances.iter().filter_map(|b| b.lamports).sum();
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };

    let (title, cached) = menubar::refresh(&dir, &state.prices, total).await;
    if let Some(tray) = app.tray_by_id(menubar::TRAY_ID) {
        let _ = tray.set_title(Some(&title));
    }
    set_status(&app, &menubar::Status::Updated(cached.updated_at));

    // Keep an open window in step. Without this the table would show figures
    // the menu bar has already superseded.
    let _ = app.emit(commands::BALANCES_CHANGED_EVENT, ());
}

/// Build the menu bar item and give it the last known total straight away, so
/// the number is on screen before the window has even opened.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    // Disabled: a read-only line reporting when the total was last updated.
    let status = MenuItem::with_id(
        app,
        menubar::MENU_STATUS,
        menubar::status_line(&menubar::Status::Never),
        false,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(
        app,
        menubar::MENU_SHOW,
        "Show LocalWallet",
        true,
        None::<&str>,
    )?;
    // Starts disabled: the vault is always locked at launch.
    let refresh = MenuItem::with_id(
        app,
        menubar::MENU_REFRESH,
        menubar::REFRESH_LOCKED_LABEL,
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, menubar::MENU_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &show, &refresh, &quit])?;
    app.manage(TrayMenu {
        status: status.clone(),
        refresh: refresh.clone(),
    });

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
            menubar::MENU_SHOW => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            // Deliberately does not touch the window: the whole point of a
            // menu bar total is updating it without being dragged into the app.
            menubar::MENU_REFRESH => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { refresh_from_tray(app).await });
            }
            menubar::MENU_QUIT => app.exit(0),
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
