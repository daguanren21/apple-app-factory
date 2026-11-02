import type { Artifact, Config, Job } from '../contracts/schemas.js';
import { join } from 'node:path';

export interface DeliveryManifest {
  projectRoot: string;
  sourcePath: string;
  executionPath: string;
  /** Recorded live-source fingerprint, not an attestation of its current bytes. */
  sourceDigest: string | null;
  /** Recorded verification fingerprint of the execution root. */
  verifiedDigest: string | null;
  artifact: Artifact | null;
  runtime: {
    cwd: string;
    /** Owner-configured runtime acceptance argv, not an observed launch result. */
    commands: Config['verification']['runtime'];
    /** Environment variable names only; values remain with the owner/host. */
    environment: Config['executionEnv'];
  };
}

export function deliveryManifest(job: Job): DeliveryManifest {
  const directory = job.spec.project?.directory ?? '.';
  const sourcePath = join(job.projectRoot, directory);
  return {
    projectRoot: job.projectRoot,
    sourcePath,
    executionPath: join(job.workspace, directory),
    sourceDigest: (job.projectRoot === job.workspace ? job.verifiedDigest : job.projectDigest) ?? null,
    verifiedDigest: job.verifiedDigest ?? null,
    artifact: job.artifact ?? null,
    runtime: {
      cwd: sourcePath,
      commands: job.config.verification.runtime,
      environment: job.config.executionEnv,
    },
  };
}
