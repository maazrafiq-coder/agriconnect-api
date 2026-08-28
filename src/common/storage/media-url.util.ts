import { StorageService } from './storage.service';

// Round 2, Milestone 4.
//
// Public-facing media (product photos, listing photos/docs) is stored
// with only `s3Key` meaningful going forward — `url` is regenerated
// fresh on every read as a presigned bucket URL rather than stored as a
// permanent static path. This means it works the same whether the
// bucket ends up configured public or private, and a URL never goes
// stale even if bucket/CDN configuration changes later.
//
// Rows created before Milestone 4 stored a legacy on-disk `url` like
// `/uploads/products/product-123.jpg` with no folder prefix in `s3Key`
// (see StorageService.isBucketKey) — those are passed through
// unchanged, since there's nothing in a bucket to presign for them.
// (In practice most pre-M4 files are already gone, since Railway's
// container filesystem is ephemeral and wipes on every redeploy — this
// fallback just avoids turning an old DB row into a broken image icon
// on top of that.)
const PRESIGNED_URL_TTL_SECONDS = 3600; // 1 hour — plenty for a page view/session

export async function withResolvedMediaUrl<T extends { url: string; s3Key: string | null }>(
  storage: StorageService,
  item: T,
): Promise<T> {
  if (storage.isBucketKey(item.s3Key)) {
    return { ...item, url: await storage.getPresignedUrl(item.s3Key, PRESIGNED_URL_TTL_SECONDS) };
  }
  return item;
}

export async function withResolvedMediaUrls<T extends { url: string; s3Key: string | null }>(
  storage: StorageService,
  items: T[],
): Promise<T[]> {
  return Promise.all(items.map((item) => withResolvedMediaUrl(storage, item)));
}
