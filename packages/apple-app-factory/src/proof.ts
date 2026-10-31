import { createHash } from 'node:crypto';
import type { Config, Job } from './schemas.js';

function verificationContract(config: Config) {
  return {
    verification: config.verification, executionEnv: config.executionEnv, toolchain: config.toolchain,
    packaging: config.packaging, apple: config.apple, packageTarget: config.packageTarget, allowCloudBuild: config.allowCloudBuild,
    isolation: config.isolation, obfuscation: config.obfuscation,
  };
}

/** Identity of the actual verification generation, not just unchanged source bytes. */
export function verificationProofDigest(job: Job): string {
  return createHash('sha256').update(JSON.stringify({
    contract: verificationContract(job.config), source: job.verifiedDigest,
    dependencies: job.verifiedDependencyDigest, screenshots: job.screenshotDigest,
    verifiedAt: job.verifiedAt, generation: job.attempts.verify ?? 0,
  })).digest('hex');
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
