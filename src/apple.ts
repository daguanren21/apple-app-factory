import { createHash, createPrivateKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { copyFile, chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { run as defaultRun } from './process.js';
import type { Run } from './process.js';
import type { AppleSpec, Spec } from './schemas.js';
import type { ApplePollResult, AppleReceipt } from './apple-types.js';
export { AppleReceiptSchema } from './apple-types.js';
export type { ApplePollResult, AppleReceipt } from './apple-types.js';

const UploadOperationSchema = z.object({
  url: z.string(), method: z.string(), offset: z.number().finite(), length: z.number().finite(),
  requestHeaders: z.array(z.object({ name: z.string(), value: z.string() })).nullish(),
});
const AttributesSchema = z.object({
  bundleId: z.string().optional(), appVersionState: z.string().nullish(), appStoreState: z.string().nullish(), state: z.string().nullish(),
  processingState: z.string().optional(), usesNonExemptEncryption: z.boolean().nullish(),
  copyright: z.string().optional(), releaseType: z.string().optional(), locale: z.string().optional(),
  description: z.string().optional(), keywords: z.string().optional(), supportUrl: z.string().optional(), whatsNew: z.string().optional(),
  privacyPolicyUrl: z.string().optional(), contactFirstName: z.string().optional(), contactLastName: z.string().optional(),
  contactEmail: z.string().optional(), contactPhone: z.string().optional(), notes: z.string().optional(), demoAccountRequired: z.boolean().optional(),
  screenshotDisplayType: z.string().optional(), fileName: z.string().optional(), sourceFileChecksum: z.string().nullish(),
  assetDeliveryState: z.object({ state: z.string().optional() }).nullish(),
  uploadOperations: z.array(UploadOperationSchema).nullish(),
});
const ResourceSchema = z.object({
  id: z.string().min(1), type: z.string().optional(), attributes: AttributesSchema.default({}),
  relationships: z.object({ appStoreVersion: z.object({ data: z.object({ id: z.string(), type: z.string().optional() }).nullish() }).optional() }).optional(),
});
const ResponseSchema = z.object({
  data: z.union([ResourceSchema, z.array(ResourceSchema)]).nullish(),
  links: z.object({ next: z.string().nullish() }).optional(),
});
const ErrorResponseSchema = z.object({ errors: z.array(z.object({ code: z.string().optional(), detail: z.string().nullish(), title: z.string().optional() })).optional() });
const ListingSchema = z.object({ results: z.array(z.object({ bundleId: z.string().optional(), version: z.string().optional() })) });
type Resource = z.infer<typeof ResourceSchema>;
type ResourceAttributes = z.infer<typeof AttributesSchema>;
type AppleResponse = z.infer<typeof ResponseSchema>;
type WriteMethod = 'POST' | 'PATCH' | 'PUT';
interface RequestOptions { method?: string; body?: unknown; optional?: boolean }
interface AppleClient {
  request(path: string, options?: RequestOptions & { optional?: false }): Promise<AppleResponse>;
  request(path: string, options: RequestOptions & { optional: true }): Promise<AppleResponse | null>;
  list(path: string | null | undefined): Promise<Resource[]>;
  credentials: { keyId: string; issuerId: string; keyPath: string };
}
type Persist = (patch?: Partial<AppleReceipt>) => Promise<void>;
type Write = (key: string, path: string, method: WriteMethod, body: unknown) => Promise<Resource | undefined>;
type Reconcile = (key: string, resource: Resource) => Promise<Resource>;
type LocalInventory = Map<string, Map<string, { bytes: Buffer; checksum: string }>>;
const publishingFields = ['appId', 'bundleId', 'version', 'buildNumber', 'locale', 'description', 'keywords', 'supportUrl', 'privacyPolicyUrl', 'reviewNotes', 'copyright'] as const;
const contactFields = ['firstName', 'lastName', 'email', 'phone'] as const;
export type PublishingSpec = AppleSpec & Required<Pick<AppleSpec, typeof publishingFields[number]>> & { contact: Required<NonNullable<AppleSpec['contact']>>; manualSetupConfirmed: true };
interface AppleOptions { spec: Pick<Spec, 'apple'>; state?: AppleReceipt; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
interface ShipOptions extends AppleOptions { ipaPath: string; save: (receipt: AppleReceipt) => void | Promise<unknown>; run?: Run; allowRelease?: boolean }
interface ScreenshotOptions {
  api: AppleClient; apple: PublishingSpec; localization: Resource;
  receipt: () => AppleReceipt; persist: Persist; write: Write; reconcile: Reconcile; signal?: AbortSignal;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function textAttribute(value: string | null | undefined): string {
  if (value === undefined || value === null) throw failure('App Store Connect returned a resource missing a required text field.', 'APPLE_API_ERROR');
  return value;
}
function resource(value: AppleResponse['data'] | undefined): Resource {
  if (!value || Array.isArray(value)) throw failure('App Store Connect returned an invalid resource.', 'APPLE_API_ERROR');
  return value;
}
function optionalResource(response: AppleResponse | null): Resource | undefined {
  return response?.data == null ? undefined : resource(response.data);
}

const API = 'https://api.appstoreconnect.apple.com';
const editable = new Set<string | null | undefined>(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'METADATA_REJECTED', 'REJECTED']);
const approved = new Set<string | null | undefined>(['ACCEPTED', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'PROCESSING_FOR_DISTRIBUTION', 'PROCESSING_FOR_APP_STORE']);
const rejected = new Set<string | null | undefined>(['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'DEVELOPER_REJECTED']);
const versionState = (resource: Resource) => resource.attributes.appVersionState ?? resource.attributes.appStoreState;
const ref = (type: string, id: string) => ({ data: { type, id } });
const matches = (resource: Resource, attributes: ResourceAttributes) => (Object.keys(attributes) as (keyof ResourceAttributes)[]).every(key => resource.attributes[key] === attributes[key]);
const query = (path: string, values: Record<string, string | number>) => `${path}?${new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]))}`;

function failure(message: string, code = 'APPLE_SETUP_REQUIRED') {
  return Object.assign(new Error(message), { code });
}

function requestFailure(message: string, code: string, httpStatus: number | null = null, transient = httpStatus === 408 || httpStatus === 429 || (httpStatus !== null && httpStatus >= 500)) {
  return Object.assign(failure(message, code), {
    httpStatus,
    transient,
    outcome: httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 ? 'rejected' : 'unknown',
  });
}

function credential(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw failure(`Set ${key} in the publisher environment. App Store Connect requires a team API key with App Manager or Admin access.`);
  return value;
}

async function client(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<AppleClient> {
  const keyId = credential(env, 'ASC_KEY_ID');
  const issuerId = credential(env, 'ASC_ISSUER_ID');
  const keyPath = credential(env, 'ASC_PRIVATE_KEY_PATH');
  if (!/^[A-Za-z0-9]+$/.test(keyId)) throw failure('ASC_KEY_ID must be an App Store Connect key identifier.');
  let key: KeyObject;
  try {
    key = createPrivateKey(await readFile(keyPath));
  } catch (error) {
    throw failure(`Cannot load ASC_PRIVATE_KEY_PATH as a private signing key: ${message(error)}`);
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw failure('ASC_PRIVATE_KEY_PATH must contain the P-256 private key downloaded from App Store Connect for ES256 authentication.');
  }
  let token: string | undefined;
  let expires = 0;
  async function request(path: string, options?: RequestOptions & { optional?: false }): Promise<AppleResponse>;
  async function request(path: string, options: RequestOptions & { optional: true }): Promise<AppleResponse | null>;
  async function request(path: string, { method = 'GET', body, optional = false }: RequestOptions = {}): Promise<AppleResponse | null> {
    const url = new URL(path, API);
    if (url.origin !== API || !/^\/v[12]\//.test(url.pathname)) throw failure('Apple returned an unexpected API URL; refusing to send publisher credentials.', 'APPLE_API_ERROR');
    const now = Math.floor(Date.now() / 1000);
    if (expires < now + 30) {
      expires = now + 600;
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = `${encode({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' })}.${encode({ iss: env.ASC_ISSUER_ID, iat: now, exp: expires, aud: 'appstoreconnect-v1' })}`;
      token = `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw requestFailure(`App Store Connect ${method} ${url.pathname} did not complete: ${message(error)}. Resume to reconcile saved writes; do not repeat an upload manually.`, 'APPLE_API_ERROR', null, true);
    }
    if (optional && response.status === 404) return null;
    const httpCode = response.status === 429 ? 'APPLE_RATE_LIMIT' : response.status >= 500 || response.status === 408 || response.ok ? 'APPLE_API_ERROR' : 'APPLE_SETUP_REQUIRED';
    let text: string;
    try { text = await response.text(); } catch (error) {
      throw requestFailure(`App Store Connect ${method} ${url.pathname} response body was lost (HTTP ${response.status}): ${message(error)}. Resume to reconcile saved writes.`, httpCode, response.status, response.ok || response.status === 408 || response.status === 429 || response.status >= 500);
    }
    let data: unknown;
    try { data = text ? JSON.parse(text) : {}; } catch { throw requestFailure(`App Store Connect returned non-JSON data for ${url.pathname} (HTTP ${response.status}).`, httpCode, response.status); }
    if (!response.ok) {
      const errors = ErrorResponseSchema.safeParse(data);
      const detail = (errors.success ? errors.data.errors?.map(error => `${error.code}: ${error.detail ?? error.title}`).join('; ') : '') || response.statusText;
      throw requestFailure(`App Store Connect ${method} ${url.pathname} failed (HTTP ${response.status}): ${detail}${response.status === 429 ? '. Request limit reached; resume later. No write was retried.' : ''}`, httpCode, response.status);
    }
    const parsed = ResponseSchema.safeParse(data);
    if (!parsed.success) throw requestFailure(`App Store Connect returned invalid resource data for ${url.pathname} (HTTP ${response.status}): ${parsed.error.message}`, httpCode, response.status);
    return parsed.data;
  }
  async function list(path: string | null | undefined): Promise<Resource[]> {
    const result: Resource[] = [];
    for (let page = 0; path; page++) {
      if (page >= 100) throw failure('App Store Connect pagination exceeded 100 pages; narrow the app/version selection.', 'APPLE_API_ERROR');
      const response = await request(path);
      if (!Array.isArray(response.data)) throw failure('App Store Connect returned an invalid resource list.', 'APPLE_API_ERROR');
      result.push(...response.data);
      path = response.links?.next;
    }
    return result;
  }
  return { request, list, credentials: { keyId, issuerId, keyPath } };
}

export async function appleDoctor({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  const checks: { name: string; available: boolean; detail: string }[] = [];
  try {
    const api = await client(env);
    await api.request('/v1/apps?limit=1');
    checks.push({ name: 'App Store Connect API', available: true, detail: 'Team key authenticated with read access. Submission permissions and app setup are checked when shipping.' });
  } catch (error) {
    checks.push({ name: 'App Store Connect API', available: false, detail: message(error) });
  }
  try {
    const result = await defaultRun(['xcrun', 'altool', '--help'], { env, timeoutMs: 30000 });
    const supported = result.code === 0 && `${result.stdout}\n${result.stderr}`.includes('--upload-package');
    checks.push({ name: 'Apple binary uploader', available: supported, detail: supported ? 'xcrun altool supports package upload. No binary was uploaded.' : 'Install/select full Xcode with a current altool supporting --upload-package; Command Line Tools alone are insufficient.' });
  } catch (error) {
    checks.push({ name: 'Apple binary uploader', available: false, detail: `Cannot invoke xcrun altool: ${message(error)}. Install/select full Xcode.` });
  }
  return checks;
}

export function validateAppleSpec(spec: Pick<Spec, 'apple'>): PublishingSpec {
  const apple = spec?.apple;
  for (const field of publishingFields) {
    const value = apple?.[field];
    if (typeof value !== 'string' || !value.trim()) throw failure(`spec.apple.${field} is required before shipping. Provide real publisher metadata, not generated placeholders.`);
  }
  for (const field of contactFields) {
    const value = apple?.contact?.[field];
    if (typeof value !== 'string' || !value.trim()) throw failure(`spec.apple.contact.${field} is required for App Review.`);
  }
  for (const field of ['supportUrl', 'privacyPolicyUrl'] as const) {
    let url: URL;
    try { url = new URL(apple?.[field] ?? ''); } catch { throw failure(`spec.apple.${field} must be a public HTTPS URL.`); }
    if (url.protocol !== 'https:' || url.username || url.password) throw failure(`spec.apple.${field} must be a public HTTPS URL without credentials.`);
  }
  if (apple?.manualSetupConfirmed !== true) throw failure('Complete App Store Connect agreements, app privacy disclosures, age rating, content rights, export compliance, pricing/availability and applicable trader/legal declarations. Then set spec.apple.manualSetupConfirmed=true as the publisher’s attestation. Automation cannot answer these declarations for you.');
  return apple as PublishingSpec;
}

async function findVersion(api: AppleClient, appId: string, version: string): Promise<Resource | undefined> {
  const versions = await api.list(query(`/v1/apps/${encodeURIComponent(appId)}/appStoreVersions`, { 'filter[platform]': 'IOS', 'filter[versionString]': version, limit: 200 }));
  if (versions.length > 1) throw failure('Multiple matching iOS App Store versions were returned; resolve the app record in App Store Connect.', 'APPLE_API_ERROR');
  return versions[0];
}

async function requireSelectedBuild(api: AppleClient, versionId: string, buildId: string | undefined) {
  if (!buildId) throw failure('The saved Apple receipt has no build ID. Restore the receipt for the verified upload before resuming.', 'APPLE_STATE_MISMATCH');
  const selected = optionalResource(await api.request(`/v1/appStoreVersions/${encodeURIComponent(versionId)}/build`, { optional: true }));
  if (selected?.id !== buildId) throw failure('The selected App Store build differs from this job’s saved upload. Restore the verified build in App Store Connect before resuming.', 'APPLE_STATE_MISMATCH');
}

function requireDeliveryProvenance(receipt: AppleReceipt): void {
  if (receipt.upload && receipt.upload.status !== 'delivered') throw failure('The saved upload has no successful delivery receipt. App Store Connect cannot prove that a matching build came from this IPA. Check Apple delivery history; do not select a build, submit, or upload again from this job.', 'APPLE_WRITE_UNCERTAIN');
}

export async function shipApple({ spec, ipaPath, state = {}, save, run = defaultRun, env = process.env, signal, allowRelease = false }: ShipOptions): Promise<AppleReceipt> {
  const apple = validateAppleSpec(spec);
  const releaseType = allowRelease === true ? 'AFTER_APPROVAL' : 'MANUAL';
  if (allowRelease && !/^[A-Za-z]{2}$/.test(apple.storefrontCountry ?? '')) throw failure('Automatic release requires apple.storefrontCountry as a two-letter country code so public listing availability can be checked.');
  if (typeof save !== 'function') throw failure('shipApple requires a durable save callback before it can make external writes.', 'APPLE_STATE_REQUIRED');
  let receipt: AppleReceipt = structuredClone(state);
  const identity = { appId: apple.appId, bundleId: apple.bundleId, version: apple.version, buildNumber: apple.buildNumber };
  if (receipt.identity && JSON.stringify(receipt.identity) !== JSON.stringify(identity)) throw failure('The saved Apple receipt belongs to another app/version/build. Resume the original job or create a new job.', 'APPLE_STATE_MISMATCH');
  requireDeliveryProvenance(receipt);
  receipt.identity = identity;
  async function persist(patch: Partial<AppleReceipt> = {}) {
    receipt = { ...receipt, ...patch };
    await save(structuredClone(receipt));
  }
  async function reconcile(key: string, resource: Resource) {
    if (receipt.pending?.key === key) await persist({ pending: null, effects: { ...receipt.effects, [key]: { id: resource?.id } }, lastEffect: { key, id: resource?.id, reconciled: true } });
    return resource;
  }
  async function write(key: string, path: string, method: WriteMethod, body: unknown): Promise<Resource | undefined> {
    if (receipt.pending) throw failure(`The saved write “${receipt.pending.key}” has an uncertain outcome. Resume after checking App Store Connect; this factory will not duplicate it.`, 'APPLE_WRITE_UNCERTAIN');
    await persist({ pending: { key, path, method, startedAt: new Date().toISOString() } });
    let result: Resource | undefined;
    try {
      result = optionalResource(await api.request(path, { method, body }));
      if (method === 'POST' && !result) throw requestFailure('App Store Connect returned no resource for a creation request. Resume to reconcile saved writes.', 'APPLE_API_ERROR');
    } catch (error) {
      if (error instanceof Error && 'outcome' in error && error.outcome === 'rejected') await persist({ pending: null });
      throw error;
    }
    await persist({ pending: null, effects: { ...receipt.effects, [key]: { id: result?.id } }, lastEffect: { key, id: result?.id, completedAt: new Date().toISOString() } });
    return result;
  }
  async function ensureAttributes(current: Resource, attributes: ResourceAttributes, key: string): Promise<Resource> {
    if (matches(current, attributes)) return reconcile(key, current);
    const type = textAttribute(current.type);
    return resource(await write(key, `/v1/${type}/${encodeURIComponent(current.id)}`, 'PATCH', { data: { type, id: current.id, attributes } }));
  }
  const api = await client(env, signal);
  const app = resource((await api.request(`/v1/apps/${encodeURIComponent(apple.appId)}`)).data);
  if (app.attributes.bundleId !== apple.bundleId) throw failure('spec.apple.appId and bundleId identify different apps. Correct the publisher specification before uploading.');
  await persist();
  let version = await findVersion(api, apple.appId, apple.version);
  if (version && !editable.has(versionState(version))) {
    const submissionId = receipt.submissionId ?? receipt.effects?.['create-review-submission']?.id;
    if (!submissionId || (receipt.versionId && receipt.versionId !== version.id)) throw failure(`Version ${apple.version} is ${versionState(version)} and has no matching submission receipt. Inspect it in App Store Connect; this factory will not overwrite or resubmit it.`, 'APPLE_WRITE_UNCERTAIN');
    await requireSelectedBuild(api, version.id, receipt.buildId);
    const submission = resource((await api.request(`/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`)).data);
    const items = await api.list(`/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion&limit=200`);
    const versionId = version.id;
    const item = items.find(item => item.relationships?.appStoreVersion?.data?.id === versionId);
    if (!item || items.length !== 1) throw failure('The saved submission does not contain only this app version. Inspect it in App Store Connect before submitting.', 'APPLE_WRITE_UNCERTAIN');
    await reconcile('add-review-item', item);
    if (submission.attributes.state === 'READY_FOR_REVIEW') {
      if (apple.screenshotsDir) {
        const localizations = await api.list(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
        const localization = localizations.find(item => item.attributes.locale === apple.locale);
        if (!localization) throw failure(`No ${apple.locale} App Store version localization exists. Restore the screenshot localization in App Store Connect before submitting.`, 'APPLE_STATE_MISMATCH');
        await verifyScreenshots({ api, apple, localization, localInventory: await readLocalScreenshots(apple.screenshotsDir) });
      }
      await write('submit-review', `/v1/reviewSubmissions/${submission.id}`, 'PATCH', { data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } });
    } else if (['WAITING_FOR_REVIEW', 'IN_REVIEW', 'COMPLETING', 'COMPLETE'].includes(submission.attributes.state ?? '')) await reconcile('submit-review', submission);
    else throw failure(`Review submission is ${submission.attributes.state}. Resolve review issues in App Store Connect; no resubmission was attempted.`);
    await persist({ submissionId: submission.id });
    await persist({ versionId: version.id, phase: 'submitted' });
    return receipt;
  }
  const ipa = await stat(ipaPath);
  if (!ipa.isFile() || ipa.size === 0) throw failure('The IPA archive is missing or empty. Package the verified app before shipping.');
  const builds = await api.list(query('/v1/builds', { 'filter[app]': apple.appId, 'filter[version]': apple.buildNumber, 'filter[preReleaseVersion.version]': apple.version, 'filter[preReleaseVersion.platform]': 'IOS', limit: 200 }));
  if (builds.length > 1) throw failure('Multiple builds match this app/version/build number. Inspect App Store Connect before resuming.', 'APPLE_STATE_MISMATCH');
  let build = builds[0];
  if (receipt.buildId && build?.id !== receipt.buildId) throw failure('The remote build differs from this job’s saved build binding. Restore the verified build before resuming; no upload was attempted.', 'APPLE_STATE_MISMATCH');
  if (build && !receipt.upload && !receipt.buildId) throw failure(`Build ${apple.version} (${apple.buildNumber}) already exists without this job’s upload receipt. Use a new build number; do not reuse an unverified remote binary.`, 'APPLE_WRITE_UNCERTAIN');
  if (!build && !receipt.upload && !receipt.buildId) {
    const help = await run(['xcrun', 'altool', '--help'], { env, signal, timeoutMs: 30000 });
    if (help.code !== 0 || !`${help.stdout}\n${help.stderr}`.includes('--upload-package')) throw failure('Select full Xcode with altool supporting --upload-package before shipping. No upload was attempted.');
    const keyDirectory = await mkdtemp(join(tmpdir(), 'factory-asc-'));
    try {
      const keyFile = join(keyDirectory, `AuthKey_${env.ASC_KEY_ID}.p8`);
      await copyFile(api.credentials.keyPath, keyFile);
      await chmod(keyFile, 0o600);
      const upload = { status: 'intent' as const, startedAt: new Date().toISOString() };
      await persist({ upload });
      const result = await run(['xcrun', 'altool', '--upload-package', ipaPath, '--platform', 'ios', '--apple-id', apple.appId, '--bundle-id', apple.bundleId, '--bundle-version', apple.buildNumber, '--bundle-short-version-string', apple.version, '--api-key', api.credentials.keyId, '--api-issuer', api.credentials.issuerId, '--wait', '--output-format', 'json'], { env: { ...env, API_PRIVATE_KEYS_DIR: keyDirectory }, signal, timeoutMs: 1200000 });
      if (result.code !== 0) throw failure(`Apple’s uploader exited with code ${result.code}. Inspect its delivery history and App Store Connect for ${apple.version} (${apple.buildNumber}); the saved upload intent prevents a duplicate upload. ${result.stderr || result.stdout}`, 'APPLE_WRITE_UNCERTAIN');
      await persist({ upload: { ...upload, status: 'delivered' }, phase: 'processing' });
    } finally {
      await rm(keyDirectory, { recursive: true, force: true });
    }
  }
  if (!build) {
    const deliveredBuilds = await api.list(query('/v1/builds', { 'filter[app]': apple.appId, 'filter[version]': apple.buildNumber, 'filter[preReleaseVersion.version]': apple.version, 'filter[preReleaseVersion.platform]': 'IOS', limit: 200 }));
    if (deliveredBuilds.length > 1) throw failure('Multiple builds match the successful delivery. Inspect App Store Connect before resuming.', 'APPLE_STATE_MISMATCH');
    build = deliveredBuilds[0];
  }
  if (!build) throw failure(`Build ${apple.version} (${apple.buildNumber}) is not visible in App Store Connect. Apple is processing the delivery; resume this job later.`, 'APPLE_PROCESSING');
  await persist({ buildId: build.id });
  if (['FAILED', 'INVALID'].includes(build.attributes.processingState ?? '')) throw failure(`Apple marked build ${apple.buildNumber} ${build.attributes.processingState}. Inspect processing errors in App Store Connect and package a corrected build with a new build number.`);
  if (build.attributes.processingState !== 'VALID') throw failure(`Apple is processing build ${apple.buildNumber}; resume this job later. No second upload will be made.`, 'APPLE_PROCESSING');
  if (build.attributes.usesNonExemptEncryption == null) throw failure('Answer export compliance for this build in App Store Connect, or set the correct ITSAppUsesNonExemptEncryption value in the app and upload a new build. The factory cannot infer your encryption declaration.');
  if (!version) version = resource(await write('create-version', '/v1/appStoreVersions', 'POST', { data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: apple.version, copyright: apple.copyright, releaseType }, relationships: { app: ref('apps', apple.appId) } } }));
  else await reconcile('create-version', version);
  await persist({ versionId: version.id });
  version = await ensureAttributes(version, { copyright: apple.copyright, releaseType }, 'version-metadata');
  const localizations = await api.list(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
  let localization = localizations.find(item => item.attributes.locale === apple.locale);
  const metadata = { description: apple.description, keywords: apple.keywords, supportUrl: apple.supportUrl, ...(apple.whatsNew ? { whatsNew: apple.whatsNew } : {}) };
  if (!localization) localization = resource(await write('create-localization', '/v1/appStoreVersionLocalizations', 'POST', { data: { type: 'appStoreVersionLocalizations', attributes: { locale: apple.locale, ...metadata }, relationships: { appStoreVersion: ref('appStoreVersions', version.id) } } }));
  else await reconcile('create-localization', localization);
  await ensureAttributes(localization, metadata, 'localization-metadata');
  const infos = await api.list(`/v1/apps/${encodeURIComponent(apple.appId)}/appInfos?limit=200`);
  const info = infos.find(item => editable.has(item.attributes.state ?? item.attributes.appStoreState));
  if (!info) throw failure('No editable app information record exists. Check app status and age rating in App Store Connect.');
  const infoLocales = await api.list(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=200`);
  const infoLocale = infoLocales.find(item => item.attributes.locale === apple.locale);
  if (!infoLocale) throw failure(`Create the ${apple.locale} app information localization in App Store Connect, including the app name and privacy policy.`);
  await ensureAttributes(infoLocale, { privacyPolicyUrl: apple.privacyPolicyUrl }, 'privacy-url');
  let review = optionalResource(await api.request(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`, { optional: true }));
  const contact = apple.contact;
  const reviewAttributes = { contactFirstName: contact.firstName, contactLastName: contact.lastName, contactEmail: contact.email, contactPhone: contact.phone, notes: apple.reviewNotes, demoAccountRequired: false };
  if (!review) review = resource(await write('create-review-details', '/v1/appStoreReviewDetails', 'POST', { data: { type: 'appStoreReviewDetails', attributes: reviewAttributes, relationships: { appStoreVersion: ref('appStoreVersions', version.id) } } }));
  else await reconcile('create-review-details', review);
  if (review.attributes?.demoAccountRequired) throw failure('This app requires a demo account. Configure review access in App Store Connect; the offline utility pipeline does not handle account credentials.');
  await ensureAttributes(review, reviewAttributes, 'review-details');
  await screenshots({ api, apple, localization, receipt: () => receipt, persist, write, reconcile, signal });
  const selected = optionalResource(await api.request(`/v1/appStoreVersions/${version.id}/build`, { optional: true }));
  if (selected?.id === build.id) await reconcile('select-build', selected);
  else await write('select-build', `/v1/appStoreVersions/${version.id}/relationships/build`, 'PATCH', { data: { type: 'builds', id: build.id } });
  let submission: Resource | undefined;
  const submissions = await api.list(query('/v1/reviewSubmissions', { 'filter[app]': apple.appId, limit: 200 }));
  for (const candidate of submissions) {
    const items = await api.list(`/v1/reviewSubmissions/${candidate.id}/items?include=appStoreVersion&limit=200`);
    const item = items.find(item => item.relationships?.appStoreVersion?.data?.id === version.id);
    if (candidate.id === receipt.submissionId || candidate.id === receipt.effects?.['create-review-submission']?.id || item) {
      if (submission && submission.id !== candidate.id) throw failure('Multiple review submissions reference this version. Resolve them in App Store Connect before resuming.', 'APPLE_WRITE_UNCERTAIN');
      submission = candidate;
      if (item) await reconcile('add-review-item', item);
    }
  }
  if (!submission && receipt.pending?.key === 'create-review-submission') throw failure('Review submission creation has an uncertain outcome. Check App Store Connect and resume after the submission becomes visible; no duplicate will be created.', 'APPLE_WRITE_UNCERTAIN');
  if (!submission) {
    if (submissions.some(item => ['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES'].includes(item.attributes.state ?? ''))) throw failure('Another active review submission exists for this app. Resolve it in App Store Connect before starting this version.');
    submission = resource(await write('create-review-submission', '/v1/reviewSubmissions', 'POST', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: ref('apps', apple.appId) } } }));
  }
  await reconcile('create-review-submission', submission);
  await persist({ submissionId: submission.id });
  if (submission.attributes.state === 'READY_FOR_REVIEW') {
    const items = await api.list(`/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion&limit=200`);
    const item = items.find(item => item.relationships?.appStoreVersion?.data?.id === version.id);
    if (items.some(item => item.relationships?.appStoreVersion?.data?.id !== version.id)) throw failure('The review submission contains other items. Inspect and submit it in App Store Connect; the factory will not submit unrelated content.');
    if (item) await reconcile('add-review-item', item);
    else await write('add-review-item', '/v1/reviewSubmissionItems', 'POST', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: ref('reviewSubmissions', submission.id), appStoreVersion: ref('appStoreVersions', version.id) } } });
    await write('submit-review', `/v1/reviewSubmissions/${submission.id}`, 'PATCH', { data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } });
  } else if (['WAITING_FOR_REVIEW', 'IN_REVIEW', 'COMPLETING', 'COMPLETE'].includes(submission.attributes.state ?? '')) await reconcile('submit-review', submission);
  else throw failure(`Review submission is ${submission.attributes.state}. Resolve review issues in App Store Connect; no resubmission was attempted.`);
  await persist({ phase: 'submitted' });
  return receipt;
}

async function readLocalScreenshots(screenshotsDir: string): Promise<LocalInventory> {
  const directories = await readdir(screenshotsDir, { withFileTypes: true });
  if (!directories.length || directories.some(entry => !entry.isDirectory() || !/^(APP|IMESSAGE_APP)_[A-Z0-9_]+$/.test(entry.name))) throw failure('screenshotsDir must contain display-type directories such as APP_IPHONE_67, each containing real app screenshots.');
  const localInventory: LocalInventory = new Map();
  for (const directory of directories) {
    const files = await readdir(join(screenshotsDir, directory.name), { withFileTypes: true });
    if (!files.length || files.length > 10 || files.some(file => !file.isFile() || !/\.(png|jpe?g)$/i.test(file.name))) throw failure(`Screenshot display set ${directory.name} must contain 1–10 PNG/JPEG files and no other entries.`);
    const inventory = new Map<string, { bytes: Buffer; checksum: string }>();
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const bytes = await readFile(join(screenshotsDir, directory.name, file.name));
      inventory.set(file.name, { bytes, checksum: createHash('md5').update(bytes).digest('hex') });
    }
    localInventory.set(directory.name, inventory);
  }
  return localInventory;
}

async function screenshots({ api, apple, localization, receipt, persist, write, reconcile, signal }: ScreenshotOptions) {
  const sets = await api.list(`/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=200`);
  let localInventory: LocalInventory | undefined;
  if (apple.screenshotsDir) {
    localInventory = await readLocalScreenshots(apple.screenshotsDir);
    const displayTypes = new Set<string>();
    for (const set of sets) {
      const displayType = textAttribute(set.attributes.screenshotDisplayType);
      const inventory = localInventory.get(displayType);
      if (!inventory || displayTypes.has(displayType)) throw failure(`Remote screenshot display set ${displayType} is extra or duplicated. Match App Store Connect to screenshotsDir before resuming; the factory will not delete publisher assets.`, 'APPLE_STATE_MISMATCH');
      displayTypes.add(displayType);
      const names = new Set<string>();
      for (const shot of await api.list(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=200`)) {
        const name = textAttribute(shot.attributes.fileName);
        const local = inventory.get(name);
        if (!local || names.has(name) || (shot.attributes.sourceFileChecksum && shot.attributes.sourceFileChecksum !== local.checksum)) throw failure(`Remote screenshot ${displayType}/${name} is extra, duplicated or differs from screenshotsDir. Match the inventories in App Store Connect before resuming; the factory will not delete publisher assets.`, 'APPLE_STATE_MISMATCH');
        names.add(name);
      }
    }
    for (const [displayType, files] of [...localInventory].sort(([a], [b]) => a.localeCompare(b))) {
      const setKey = `screenshot-set:${displayType}`;
      let set = sets.find(set => set.attributes.screenshotDisplayType === displayType);
      if (set) await reconcile(setKey, set);
      else {
        set = resource(await write(setKey, '/v1/appScreenshotSets', 'POST', { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: displayType }, relationships: { appStoreVersionLocalization: ref('appStoreVersionLocalizations', localization.id) } } }));
        sets.push(set);
      }
      const existing = await api.list(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=200`);
      for (const [name, { bytes, checksum }] of files) {
        const key = `screenshot:${displayType}:${name}:${checksum}`;
        let shot = existing.find(item => item.attributes.fileName === name);
        if (shot?.attributes.sourceFileChecksum && shot.attributes.sourceFileChecksum !== checksum) throw failure(`Remote screenshot ${displayType}/${name} differs from the workspace. Replace it in App Store Connect or use a new filename; the factory will not delete publisher assets.`, 'APPLE_STATE_MISMATCH');
        if (shot && !shot.attributes.sourceFileChecksum && receipt().effects?.[key]?.id !== shot.id && receipt().pending?.key !== key) throw failure(`Screenshot ${displayType}/${name} has an unfinished reservation not owned by this job. Finish or remove it in App Store Connect before resuming.`, 'APPLE_WRITE_UNCERTAIN');
        if (shot) await reconcile(key, shot);
        else {
          shot = resource(await write(key, '/v1/appScreenshots', 'POST', { data: { type: 'appScreenshots', attributes: { fileName: basename(name), fileSize: bytes.length }, relationships: { appScreenshotSet: ref('appScreenshotSets', set.id) } } }));
          existing.push(shot);
        }
        const delivery = shot.attributes.assetDeliveryState?.state;
        if (delivery === 'FAILED') throw failure(`Apple rejected screenshot ${displayType}/${name}. Inspect its asset errors in App Store Connect and replace the failed reservation.`);
        if (delivery === 'COMPLETE') {
          await reconcile(`${key}:commit`, shot);
          continue;
        }
        if (delivery === 'AWAITING_UPLOAD') {
          if (!shot.attributes.uploadOperations?.length) throw failure('Apple returned no screenshot upload operations. Inspect the reservation in App Store Connect.', 'APPLE_API_ERROR');
          // Apple explicitly permits replaying asset parts until commit: https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect
          for (const [index, operation] of (shot.attributes.uploadOperations ?? []).entries()) {
            if (index < (receipt().assetParts?.[shot.id] ?? 0)) continue;
            const url = new URL(operation.url);
            if (url.protocol !== 'https:' || !url.hostname.endsWith('.apple.com') || operation.method !== 'PUT' || !Number.isInteger(operation.offset) || !Number.isInteger(operation.length) || operation.offset < 0 || operation.length <= 0 || operation.offset + operation.length > bytes.length) throw failure('Apple returned invalid screenshot upload instructions; no data was sent.', 'APPLE_API_ERROR');
            const partKey = `${key}:part:${index}`;
            const pending = receipt().pending;
            if (pending && pending.key !== partKey) throw failure(`A previous Apple write “${pending.key}” is unresolved. Resume after checking its outcome.`, 'APPLE_WRITE_UNCERTAIN');
            await persist({ pending: { key: partKey, method: 'PUT', startedAt: new Date().toISOString() } });
            let response: Response;
            try {
              const part = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset + operation.offset, operation.length);
              response = await fetch(url, { method: operation.method, redirect: 'error', headers: Object.fromEntries((operation.requestHeaders ?? []).map(header => [header.name, header.value])), body: part, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
            } catch (error) {
              throw requestFailure(`Apple screenshot part upload did not complete: ${message(error)}. Resume to resend the uncommitted part.`, 'APPLE_API_ERROR');
            }
            if (!response.ok) {
              const error = requestFailure(`Apple screenshot part upload failed (HTTP ${response.status}); resume to resend the uncommitted part.`, response.status === 429 ? 'APPLE_RATE_LIMIT' : 'APPLE_API_ERROR', response.status);
              if (error.outcome === 'rejected') await persist({ pending: null });
              throw error;
            }
            try { await response.arrayBuffer(); } catch (error) {
              throw Object.assign(requestFailure(`Apple screenshot part upload response was lost (HTTP ${response.status}): ${message(error)}. Resume to resend the uncommitted part.`, 'APPLE_API_ERROR', response.status), { outcome: 'unknown' });
            }
            await persist({ pending: null, assetParts: { ...receipt().assetParts, [shot.id]: index + 1 }, lastEffect: { key: partKey, completedAt: new Date().toISOString() } });
          }
          await write(`${key}:commit`, `/v1/appScreenshots/${shot.id}`, 'PATCH', { data: { type: 'appScreenshots', id: shot.id, attributes: { uploaded: true, sourceFileChecksum: checksum } } });
        } else if (delivery === 'UPLOAD_COMPLETE') await reconcile(`${key}:commit`, shot);
      }
    }
  }
  await verifyScreenshots({ api, apple, localization, localInventory, sets });
}

async function verifyScreenshots({ api, apple, localization, localInventory, sets = [] }: { api: AppleClient; apple: PublishingSpec; localization: Resource; localInventory?: LocalInventory; sets?: Resource[] }) {
  let complete = 0;
  if (localInventory) sets = await api.list(`/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets?limit=200`);
  const displayTypes = new Set<string>();
  for (const set of sets) {
    const displayType = textAttribute(set.attributes.screenshotDisplayType);
    const inventory = localInventory?.get(displayType);
    if (localInventory && (!inventory || displayTypes.has(displayType))) throw failure(`Remote screenshot display set ${displayType} is extra or duplicated. Match App Store Connect to screenshotsDir before submitting; the factory will not delete publisher assets.`, 'APPLE_STATE_MISMATCH');
    displayTypes.add(displayType);
    const names = new Set<string>();
    for (const shot of await api.list(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=200`)) {
      if (inventory) {
        const name = textAttribute(shot.attributes.fileName);
        const local = inventory.get(name);
        if (!local || names.has(name) || shot.attributes.sourceFileChecksum !== local.checksum) throw failure(`Remote screenshot ${displayType}/${name} does not exactly match screenshotsDir. Match filenames and checksums in App Store Connect before submitting; the factory will not delete publisher assets.`, 'APPLE_STATE_MISMATCH');
        names.add(name);
      }
      if (shot.attributes.assetDeliveryState?.state !== 'COMPLETE') throw failure('Apple has not finished processing all screenshots. Check failed assets in App Store Connect or resume when processing finishes.', 'APPLE_PROCESSING');
      complete++;
    }
    if (inventory && names.size !== inventory.size) throw failure(`Remote screenshots for ${displayType} are missing files from screenshotsDir. Resume after the uploaded assets become visible.`, 'APPLE_PROCESSING');
  }
  if (localInventory && displayTypes.size !== localInventory.size) throw failure('Remote screenshot display sets are missing entries from screenshotsDir. Resume after the uploaded sets become visible.', 'APPLE_PROCESSING');
  if (!complete) throw failure(`No processed screenshots exist for ${apple.locale}. Set spec.apple.screenshotsDir to real screenshots grouped by Apple display type, or upload screenshots in App Store Connect.`);
}


export async function pollApple({ spec, state = {}, env = process.env, signal }: AppleOptions): Promise<ApplePollResult> {
  requireDeliveryProvenance(state);
  const apple = spec?.apple;
  if (!apple?.appId || !apple.version) throw failure('Polling requires spec.apple.appId and version.');
  const api = await client(env, signal);
  const version = await findVersion(api, apple.appId, apple.version);
  if (!version) return { status: 'waiting', detail: `Version ${apple.version} is not visible in App Store Connect.` };
  if (state.versionId && version.id !== state.versionId) throw failure('The App Store version differs from the saved receipt. Inspect the app record before resuming.', 'APPLE_STATE_MISMATCH');
  const status = versionState(version);
  if (approved.has(status)) {
    await requireSelectedBuild(api, version.id, state.buildId);
    const distributionReady = ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'].includes(status ?? '');
    let available = false;
    if (distributionReady && apple.storefrontCountry) {
      if (!/^[A-Za-z]{2}$/.test(apple.storefrontCountry)) throw failure('apple.storefrontCountry must be a two-letter country code.');
      const url = new URL('https://itunes.apple.com/lookup');
      url.search = new URLSearchParams({ id: apple.appId, country: apple.storefrontCountry }).toString();
      let response: Response;
      try {
        response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
      } catch (error) {
        throw requestFailure(`Public App Store lookup did not complete: ${message(error)}. Resume to check publication.`, 'APPLE_API_ERROR', null, true);
      }
      if (!response.ok) throw requestFailure(`Public App Store lookup failed (HTTP ${response.status}); publication has not been proven.`, 'APPLE_API_ERROR', response.status);
      let text: string;
      try { text = await response.text(); } catch (error) {
        throw requestFailure(`Public App Store lookup response was lost: ${message(error)}. Resume to check publication.`, 'APPLE_API_ERROR', response.status, true);
      }
      let data: unknown;
      try { data = JSON.parse(text); } catch {
        throw failure('Public App Store lookup returned non-JSON data; publication has not been proven.', 'APPLE_API_ERROR');
      }
      const parsed = ListingSchema.safeParse(data);
      if (!parsed.success) throw failure(`Public App Store lookup returned invalid data: ${parsed.error.message}`, 'APPLE_API_ERROR');
      available = parsed.data.results.some(item => item.bundleId === apple.bundleId && item.version === apple.version);
    }
    return { status: 'approved', distributionReady, available, detail: `Apple version state: ${status}. Approval does not imply public availability; lookup of the exact bundle/version ${available ? 'confirmed the configured storefront' : 'has not confirmed the configured storefront'}.` };
  }
  if (rejected.has(status)) return { status: 'rejected', detail: `Apple version state: ${status}. Read App Review messages in App Store Connect before changing or resubmitting the app.` };
  return { status: 'waiting', detail: `Apple version state: ${status}.` };
}
