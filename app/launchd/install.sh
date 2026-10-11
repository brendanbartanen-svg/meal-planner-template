#!/bin/bash
# Install, restart, or remove the Meal Planner LaunchAgent for the current
# user. The plist next to this script is a template; this fills in the app
# directory (wherever this checkout lives) and the log path under $HOME.
#
#   app/launchd/install.sh             render + install + start (re-run after moving the repo)
#   app/launchd/install.sh restart     restart the server, unless a run is in flight
#   app/launchd/install.sh uninstall   stop and remove the agent
#   app/launchd/install.sh --print     print the rendered plist, change nothing
set -euo pipefail

LABEL="com.mealplanner.app"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/.." && pwd)"
TEMPLATE="$HERE/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_FILE="$HOME/Library/Logs/meal-planner.log"
DOMAIN="gui/$(id -u)"
PORT="${MEALAPP_PORT:-4316}"

# XML-escape a path, then escape it for the replacement side of sed.
esc() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    | sed -e 's/[\\&|]/\\&/g'
}

render() {
  sed -e "s|__APP_DIR__|$(esc "$APP_DIR")|g" \
      -e "s|__LOG_FILE__|$(esc "$LOG_FILE")|g" "$TEMPLATE"
}

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

case "${1:-install}" in
  --print)
    render
    ;;

  install)
    [ -d "$APP_DIR/node_modules" ] || { echo "Run 'npm ci' in $APP_DIR first." >&2; exit 1; }
    if [ ! -s "$HOME/.nvm/nvm.sh" ] && ! command -v npm >/dev/null 2>&1; then
      echo "Warning: no nvm and no npm on PATH — the agent will not be able to start node." >&2
    fi
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi
    render > "$DEST"
    plutil -lint "$DEST" >/dev/null
    launchctl bootstrap "$DOMAIN" "$DEST"
    echo "Installed $LABEL"
    echo "  app:  $APP_DIR"
    echo "  log:  $LOG_FILE"
    echo "  url:  http://localhost:$PORT"
    ;;

  restart)
    # Run state is in-memory: restarting mid-run kills the run.
    if curl -fsS "http://localhost:$PORT/api/run" 2>/dev/null | grep -q '"active":true'; then
      echo "A run is in flight — wait for it to finish (GET /api/run shows active:false), then retry." >&2
      exit 1
    fi
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Restarted $LABEL"
    ;;

  uninstall)
    if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi
    rm -f "$DEST"
    echo "Removed $LABEL"
    ;;

  *)
    echo "usage: $0 [install|restart|uninstall|--print]" >&2
    exit 2
    ;;
esac
