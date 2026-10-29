import type { Config, Job } from './schemas.js';

function verificationContract(config: Config) {
  return {
    verification: config.verification, executionEnv: config.executionEnv, toolchain: config.toolchain,
    packaging: config.packaging, apple: config.apple, packageTarget: config.packageTarget, allowCloudBuild: config.allowCloudBuild,
    isolation: config.isolation,
  };
}

export function verificationConfigChanged(job: Job, config: Config): boolean {
  return JSON.stringify(verificationContract(job.config)) !== JSON.stringify(verificationContract(config))
    || (job.verifiedDigest != null && !job.verifiedDependencyDigest);
}

export function invalidateVerification(): Partial<Job> {
  return {
    verifiedDigest: null, verifiedDependencyDigest: null, screenshotDigest: null, verifiedAt: undefined,
    review: null, reviewPolicyContextDigest: null, artifact: null, ipaPath: null, archiveDigest: null,
  };
}
