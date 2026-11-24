#!/bin/bash
# Launch the Next dev server with a clean environment.
#
# Two environment problems are handled here rather than in the app:
#  1. VIRTUAL_ENV is inherited from whatever shell started Claude Code. When it
#     points at another project's venv, anything starting Python in this directory
#     aborts on a sandbox read. Nothing here uses Python, so it is removed.
#  2. node and pnpm live in ~/.local, not /usr/local, so PATH is set explicitly.
unset VIRTUAL_ENV PYTHONHOME PYTHONPATH PYTHONSTARTUP CONDA_PREFIX
export PATH="$HOME/.local/node-v22.11.0-darwin-x64/bin:$PATH"
cd "$(dirname "$0")/.."
exec node node_modules/next/dist/bin/next dev --turbopack --port 3000 "$@"
