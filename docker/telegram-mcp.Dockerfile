# Derived image: the vendor telegram-mcp plus notebooklm-mcp-cli, so one
# container runs both MCP servers (telegram :8765, notebooklm :8766).
# scripts/update.sh first builds the base image from the telegram-mcp fork at
# the pinned commit and tags it telegram-memory/telegram-mcp-base:<commit>.
# Every argument comes from config/vendors.json; there are no defaults.
ARG TELEGRAM_MCP_COMMIT
FROM telegram-memory/telegram-mcp-base:${TELEGRAM_MCP_COMMIT}
ARG TELEGRAM_MCP_REPO
ARG TELEGRAM_MCP_COMMIT
ARG NOTEBOOKLM_MCP_CLI_REPO
ARG NOTEBOOKLM_MCP_CLI_COMMIT

# notebooklm-mcp-cli from the pinned commit of its fork, not from PyPI.
ADD ${NOTEBOOKLM_MCP_CLI_REPO}#${NOTEBOOKLM_MCP_CLI_COMMIT} /tmp/notebooklm-mcp-cli

# notebooklm-mcp-cli needs fastmcp with mcp 2.x while telegram-mcp needs mcp 1.x,
# so it gets its own virtual environment; only its commands are put on PATH.
USER root
# /app/data and /exchange are volume-mounted and must exist with appuser
# ownership, or the processes cannot write state and media.
RUN python -m venv /opt/notebooklm \
    && /opt/notebooklm/bin/pip install --no-cache-dir /tmp/notebooklm-mcp-cli \
    && ln -s /opt/notebooklm/bin/nlm /opt/notebooklm/bin/notebooklm-mcp /usr/local/bin/ \
    && rm -rf /tmp/notebooklm-mcp-cli \
    && mkdir -p /app/data/nlm /exchange \
    && chown -R appuser:appuser /app/data /exchange
COPY telegram-entrypoint.sh /usr/local/bin/telegram-memory-entrypoint.sh
USER appuser

# nlm state (rotating cookies, CSRF, profiles) lives in the telegram_data volume
# because the container filesystem stays read-only.
ENV NOTEBOOKLM_MCP_CLI_PATH=/app/data/nlm

LABEL com.telegram-memory.vendor.telegram-mcp.repo=${TELEGRAM_MCP_REPO} \
      com.telegram-memory.vendor.telegram-mcp.commit=${TELEGRAM_MCP_COMMIT} \
      com.telegram-memory.vendor.notebooklm-mcp-cli.repo=${NOTEBOOKLM_MCP_CLI_REPO} \
      com.telegram-memory.vendor.notebooklm-mcp-cli.commit=${NOTEBOOKLM_MCP_CLI_COMMIT}
