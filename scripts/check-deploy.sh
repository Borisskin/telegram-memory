#!/usr/bin/env bash
# Check the composition without starting containers.
#   sudo scripts/check-deploy.sh      → RESULT=ok | RESULT=failed check <reasons>
source "$(dirname "$0")/lib.sh"
(($# == 0)) || usage "usage: sudo scripts/check-deploy.sh"
tm_start check-deploy
check_stack
result 0 ok
