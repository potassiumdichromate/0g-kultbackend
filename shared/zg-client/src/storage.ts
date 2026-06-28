import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, writeFile, unlink } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { withRetry } from "@platform/utils";

export interface UploadResult {
  rootHash: string;
  txHash?: string;
}

/**
 * The only place encoded save bytes are ever persisted. save-service never writes them
 * anywhere else (not Postgres, not Redis long-term) — see the ground rule in
 * shared/db/prisma/schema.prisma. Two implementations, chosen by createStorageDriver()
 * based on env, so swapping to real 0G in production is a config change, not a code change.
 */
export interface StorageDriver {
  readonly mode: "0g" | "local-disk";
  upload(buffer: Buffer): Promise<UploadResult>;
  download(rootHash: string): Promise<Buffer>;
}

/**
 * Ported from zerodash-0g-backend/src/services/ZeroGStorage.js and
 * warzone-backend-0g/src/services/ZeroGStorage.js (the two were near-identical — exactly
 * the kind of duplicated infrastructure code this platform exists to consolidate).
 * Same approach: temp file -> ZgFile -> Merkle root -> indexer.upload with a rotating list
 * of indexer endpoints and retry-with-backoff; same on download.
 */
export function createZgStorageDriver(env: {
  privateKey: string;
  rpcUrl: string;
  indexerRpc?: string;
}): StorageDriver {
  const indexers = [
    env.indexerRpc,
    "https://indexer-storage-turbo-v2.0g.ai",
    "https://indexer-storage-turbo.0g.ai",
    "https://indexer-storage-turbo-standard.0g.ai",
  ].filter((v, i, arr): v is string => Boolean(v) && arr.indexOf(v) === i);

  let indexerIdx = 0;

  // Lazy require: the real 0G SDK is a heavy, network-calling dependency that should only
  // ever be loaded when this driver is actually selected (i.e. ZG_PRIVATE_KEY is configured).
  async function loadSdk() {
    const { ethers } = await import("ethers");
    const sdk = await import("@0gfoundation/0g-storage-ts-sdk");
    return { ethers, sdk };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function withIndexer<T>(fn: (indexer: any, signer: any) => Promise<T>): Promise<T> {
    const { ethers, sdk } = await loadSdk();
    const provider = new ethers.JsonRpcProvider(env.rpcUrl);
    const signer = new ethers.Wallet(env.privateKey, provider);
    try {
      const indexer = new sdk.Indexer(indexers[indexerIdx]);
      return await fn(indexer, signer);
    } catch (err) {
      indexerIdx = (indexerIdx + 1) % indexers.length; // rotate on failure, same as ZeroGStorage.js
      throw err;
    }
  }

  return {
    mode: "0g",
    async upload(buffer: Buffer): Promise<UploadResult> {
      return withRetry(
        async () => {
          const tmpPath = join(tmpdir(), `zg-upload-${randomBytes(8).toString("hex")}`);
          writeFileSync(tmpPath, buffer);
          try {
            return await withIndexer(async (indexer, signer) => {
              const { sdk } = await loadSdk();
              const zgFile = await sdk.ZgFile.fromFilePath(tmpPath);
              const [tree, treeErr] = await zgFile.merkleTree();
              if (treeErr || !tree) {
                throw new Error(`0G Storage merkleTree() failed: ${treeErr ?? "no tree returned"}`);
              }
              const rootHash = tree.rootHash();
              if (!rootHash) {
                throw new Error("0G Storage merkleTree() returned an empty rootHash");
              }
              const [uploadResult] = await indexer.upload(zgFile, env.rpcUrl, signer);
              await zgFile.close();
              const txHash =
                typeof uploadResult === "string" ? uploadResult : uploadResult?.txHash ?? uploadResult?.txSeq;
              return { rootHash, txHash };
            });
          } finally {
            rmSync(tmpPath, { force: true });
          }
        },
        { label: "0G Storage upload", maxAttempts: 3, baseDelayMs: 4000 },
      );
    },
    async download(rootHash: string): Promise<Buffer> {
      return withRetry(
        async () => {
          const tmpPath = join(tmpdir(), `zg-download-${randomBytes(8).toString("hex")}`);
          try {
            await withIndexer(async (indexer) => {
              await indexer.download(rootHash, tmpPath, true);
            });
            return readFileSync(tmpPath);
          } finally {
            rmSync(tmpPath, { force: true });
          }
        },
        { label: "0G Storage download", maxAttempts: 3, baseDelayMs: 4000 },
      );
    },
  };
}

/**
 * Dev/verification stand-in for the real 0G driver, used automatically whenever
 * ZG_PRIVATE_KEY isn't configured (no real 0G credentials are available in this
 * environment — the same honest constraint as Round 1's Warzone-URL gap). Computes a
 * sha256-based "rootHash" and persists the blob to a local directory. This is what makes
 * the save/load round trip in save-service actually testable end to end here, while the
 * driver interface stays identical to the real one.
 */
export function createLocalDiskStorageDriver(baseDir: string): StorageDriver {
  mkdirSync(baseDir, { recursive: true });

  const pathFor = (rootHash: string) => join(baseDir, `${rootHash.replace(/^0x/, "")}.bin`);

  return {
    mode: "local-disk",
    async upload(buffer: Buffer): Promise<UploadResult> {
      const hash = createHash("sha256").update(buffer).digest("hex");
      const rootHash = `0x${hash}`;
      await new Promise<void>((resolve, reject) =>
        writeFile(pathFor(rootHash), buffer, (err) => (err ? reject(err) : resolve())),
      );
      return { rootHash };
    },
    async download(rootHash: string): Promise<Buffer> {
      const path = pathFor(rootHash);
      if (!existsSync(path)) {
        throw new Error(`local-disk storage driver: no blob found for rootHash ${rootHash}`);
      }
      return readFileSync(path);
    },
  };
}

export interface CreateStorageDriverOptions {
  logger?: Logger;
  localDiskDir?: string;
}

/** Selects the real 0G driver if credentials are configured, local-disk otherwise. */
export function createStorageDriver(opts: CreateStorageDriverOptions = {}): StorageDriver {
  const privateKey = process.env.ZG_PRIVATE_KEY;
  const rpcUrl = process.env.ZG_RPC_URL || process.env.OG_MAINNET_RPC;

  if (privateKey && rpcUrl) {
    opts.logger?.info("zg-client: using real 0G Storage driver");
    return createZgStorageDriver({ privateKey, rpcUrl, indexerRpc: process.env.ZG_INDEXER_RPC });
  }

  const dir = opts.localDiskDir || join(tmpdir(), "0g-kultbrowser-local-storage");
  opts.logger?.warn(
    { dir },
    "zg-client: ZG_PRIVATE_KEY/ZG_RPC_URL not set — using local-disk storage driver (dev/verification only, not production)",
  );
  return createLocalDiskStorageDriver(dir);
}

export function unlinkQuiet(path: string): void {
  unlink(path, () => undefined);
}
