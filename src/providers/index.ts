// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude) don't appear here.
//
// Skills add a new provider by appending one import line below.

// Fork: this install routes the Claude provider through a custom
// Anthropic-compatible endpoint (ANTHROPIC_BASE_URL in .env — the vault holds
// the real credential). Trunk's stock claude install needs no host-side
// contribution, but without this registration the endpoint/model overrides
// never reach the container and the SDK targets api.anthropic.com, where the
// vault has no credential (401 "No credentials configured" from the gateway).
import './claude.js';
