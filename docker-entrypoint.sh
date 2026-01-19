#!/bin/sh
set -e

# If running as root, fix permissions and switch to botuser
if [ "$(id -u)" = "0" ]; then
    # Create data directory if it doesn't exist and fix permissions
    # This handles Railway's root-owned volume mounts
    mkdir -p /app/data
    chown -R botuser:botuser /app/data
    chmod 755 /app/data

    # Execute the command as botuser using su-exec
    exec su-exec botuser "$@"
fi

# If already running as non-root, just execute the command
exec "$@"
