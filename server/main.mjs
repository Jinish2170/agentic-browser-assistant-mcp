import { loadConfig, configPath } from './config.mjs';
import { createBridge } from './bridge.mjs';

try {
  const config = await loadConfig();
  const bridge = await createBridge(config);
  await bridge.listen();
  console.error(`JEV Browser bridge listening on http://127.0.0.1:${config.port}`);
  console.error(`Pair the extension with the token in ${configPath}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await bridge.close();
      process.exit(0);
    });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
