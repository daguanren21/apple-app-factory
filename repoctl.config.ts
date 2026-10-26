import { defineMonorepoConfig } from 'repoctl'

export default defineMonorepoConfig({
  commands: {
    init: {
      preset: 'minimal',
    },
    create: {
      defaultTemplate: 'tsdown',
    },
    release: {
      branches: {
        stable: 'main',
        prerelease: [],
      },
      // The root test script already typechecks and builds; this project has no lint script.
      qualityScripts: ['test'],
      hooks: {
        verify: ['package:check'],
      },
    },
  },
})
