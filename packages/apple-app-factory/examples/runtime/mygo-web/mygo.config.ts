export default {
  name: "MyGo Web App",
  identifier: "org.example.apphx.mygo.web.smoke",
  version: "0.1.0",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
  macos: { signingIdentity: "-" },
};
