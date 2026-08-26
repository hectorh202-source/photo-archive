#!/bin/sh
set -e

# Runs once as root before dropping to the unprivileged "node" user. A volume
# created by an older root-running deployment stays root-owned, which would
# leave the non-root process unable to write its own database — chowning on
# every start self-heals that rather than needing a manual fix on the VPS.
mkdir -p /data /archives
chown -R node:node /data /archives

exec gosu node "$@"
