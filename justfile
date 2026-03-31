# opencode-auto-continue

default:
    @just --list

# Install dependencies
install:
    bun install

# Build TypeScript to dist/
build:
    bun run build

# Watch mode — rebuild on changes
dev:
    bun run dev

# Clean build artifacts
clean:
    rm -rf dist

# Full rebuild from scratch
rebuild: clean install build

# Type-check without emitting
check:
    tsc --noEmit

# Show package info
info:
    @echo "name: $(jq -r .name package.json)"
    @echo "version: $(jq -r .version package.json)"
    @echo "main: $(jq -r .main package.json)"
    @ls -lh dist/ 2>/dev/null || echo "dist/ not built yet"
