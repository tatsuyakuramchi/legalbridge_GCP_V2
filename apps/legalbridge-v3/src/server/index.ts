import { createApp } from "./app.js";
import { config } from "./config.js";

createApp().listen(config.port, () => {
  console.log(`LegalBridge V3 listening on :${config.port} (schema=${config.databaseSchema})`);
});
