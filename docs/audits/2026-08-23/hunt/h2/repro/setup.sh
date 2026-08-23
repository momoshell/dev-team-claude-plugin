#!/bin/sh
# Build the scratch copy every repro in this directory runs against.
# NEVER runs against the checkout: `git archive HEAD` extracts a pristine tree
# into a temp dir, so nothing here can modify the working copy.
#
#   sh setup.sh [checkout-path]   ->  prints the scratch repo path on stdout
set -e
CHECKOUT="${1:-/Users/x/Development/dt-s2-factory}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/h2-repro-XXXXXX")"
mkdir -p "$SCRATCH/repo"
git -C "$CHECKOUT" archive HEAD | tar -x -C "$SCRATCH/repo"
echo "$SCRATCH/repo"
