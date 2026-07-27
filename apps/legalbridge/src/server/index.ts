import { createApp } from "./app.js";
import { config } from "./config.js";

createApp().listen(config.port, () => {
  console.log(`LegalBridge V2 listening on :${config.port}`);
});
