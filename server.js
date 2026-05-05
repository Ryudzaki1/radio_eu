const { createServer } = require("./src/app");
const { config, ensureRuntimeDirs } = require("./src/config");

ensureRuntimeDirs();

const server = createServer(config);

  server.listen(config.port, () => {
    console.log(`AI Chill Radio: http://localhost:${config.port}`);
    console.log(`Live music folder: ${config.liveMusicDir}`);
    console.log(`Play music folder: ${config.playMusicDir}`);
  });
