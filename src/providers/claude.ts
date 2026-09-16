/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * The real auth token never enters the container. Setup creates an
 * OneCLI generic secret (host-pattern = base URL hostname, header-name
 * = Authorization, value-format = "Bearer {value}") so the proxy
 * rewrites the Authorization header on the wire. The container only
 * needs:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/** Model-override env names passed through when present in the host .env (fork). */
const MODEL_OVERRIDE_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', ...MODEL_OVERRIDE_KEYS]);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }
  // Presence-only passthrough: unset names are simply absent. Rides
  // contributedEnv, the lane exempt from the credential-NAME check.
  // DB-driven model selection (container_configs.model +
  // NANOCLAW_DEFAULT_MODEL) wins wherever the install uses it.
  for (const key of MODEL_OVERRIDE_KEYS) {
    if (dotenv[key]) env[key] = dotenv[key];
  }
  return { env };
});
