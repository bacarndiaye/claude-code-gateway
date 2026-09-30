import { query } from '@anthropic-ai/claude-agent-sdk';
import { ConfigError, loadConfig } from './config.ts';
import { createGateway } from './server.ts';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`configuration invalide : ${err.message}`);
    process.exit(2);
  }
  throw err;
}

const { server, jobs } = createGateway(cfg, { query });

server.listen(cfg.port, cfg.host, () => {
  console.log(`claude-code-gateway à l'écoute sur http://${cfg.host}:${cfg.port}`);
  console.log(`  dossiers autorisés : ${cfg.roots.join(', ')}`);
  console.log(`  outils autorisés   : ${cfg.allowedTools.join(', ')}`);
  console.log(`  runs simultanés    : ${cfg.maxConcurrent}, délai ${cfg.timeoutMs} ms, budget ${cfg.maxBudgetUsd} USD`);
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && cfg.host !== '::1') {
    console.warn('  ⚠ écoute hors boucle locale : placer un proxy TLS devant, le jeton circule en clair sinon');
  }
});

function shutdown(signal: string): void {
  console.log(`${signal} reçu : annulation de ${jobs.size} run(s) et arrêt`);
  jobs.abortAll();
  server.close(() => process.exit(0));
  // Filet : un client SSE qui ne se ferme pas ne doit pas bloquer l'arrêt.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
