# For MCP directories that inspect a server in a sandbox (Glama builds this file, starts the server and calls
# tools/list). It installs the jevmem CLI from npm and starts `jevmem mcp` on an empty project: with no TypeSafe key and
# no enabled project the server still answers initialize and tools/list, and a tool call replies that jevmem isn't
# enabled there. It is not how jevmem is installed or used: see docs/mcp.md.
FROM node:22-slim
RUN npm install -g jevmem@0.7.0 && mkdir /project
USER node
WORKDIR /project
ENTRYPOINT ["jevmem", "mcp", "--root", "/project"]
