import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const VALID_ENTITY_TYPES = ['warehouse', 'testing_agency', 'transport'] as const;
type EntityType = typeof VALID_ENTITY_TYPES[number];

/**
 * Handles photo/document uploads for the three listing types that don't
 * have their own dedicated media table (Product already has ProductMedia).
 * Ownership is checked against the relevant profile table before any
 * write, so a seller can't upload photos onto someone else's warehouse.
 */
@Injectable()
export class MediaService {
  constructor(private prisma: PrismaService) {}

  private async assertOwnership(entityType: EntityType, entityId: string, userId: string) {
    let ownerId: string | undefined;
    if (entityType === 'warehouse') {
      const w = await this.prisma.warehouseProfile.findUnique({ where: { id: entityId } });
      if (!w) throw new NotFoundException('Warehouse not found');
      ownerId = w.userId;
    } else if (entityType === 'testing_agency') {
      const a = await this.prisma.testingAgencyProfile.findUnique({ where: { id: entityId } });
      if (!a) throw new NotFoundException('Testing agency not found');
      ownerId = a.userId;
    } else if (entityType === 'transport') {
      const t = await this.prisma.transportProfile.findUnique({ where: { id: entityId } });
      if (!t) throw new NotFoundException('Transport provider not found');
      ownerId = t.userId;
    } else {
      throw new BadRequestException('Invalid entity type');
    }
    if (ownerId !== userId) throw new ForbiddenException('You do not own this listing');
  }

  async upload(entityType: EntityType, entityId: string, userId: string, files: any[], type: 'image' | 'document') {
    if (!VALID_ENTITY_TYPES.includes(entityType)) throw new BadRequestException('Invalid entity type');
    await this.assertOwnership(entityType, entityId, userId);

    const existingCount = await this.prisma.listingMedia.count({ where: { entityType, entityId } });

    const created = await Promise.all(
      files.map((file, i) =>
        this.prisma.listingMedia.create({
          data: {
            entityType,
            entityId,
            type,
            url: `/uploads/listings/${file.filename}`,
            s3Key: file.filename,
            uploadedBy: userId,
            sortOrder: existingCount + i,
            // First image uploaded for a listing with none yet becomes the
            // display picture automatically.
            isPrimary: type === 'image' && existingCount === 0 && i === 0,
          },
        })
      )
    );
    return created;
  }

  async list(entityType: EntityType, entityId: string) {
    return this.prisma.listingMedia.findMany({
      where: { entityType, entityId },
      orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
    });
  }

  async setPrimary(mediaId: string, userId: string) {
    const media = await this.prisma.listingMedia.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');
    await this.assertOwnership(media.entityType as EntityType, media.entityId, userId);

    await this.prisma.$transaction([
      this.prisma.listingMedia.updateMany({
        where: { entityType: media.entityType, entityId: media.entityId },
        data: { isPrimary: false },
      }),
      this.prisma.listingMedia.update({ where: { id: mediaId }, data: { isPrimary: true } }),
    ]);
    return { message: 'Display picture updated' };
  }

  async remove(mediaId: string, userId: string) {
    const media = await this.prisma.listingMedia.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');
    await this.assertOwnership(media.entityType as EntityType, media.entityId, userId);
    await this.prisma.listingMedia.delete({ where: { id: mediaId } });
    return { message: 'Removed' };
  }
}
