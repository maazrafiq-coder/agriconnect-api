import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { NotificationType, OfferStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

export class PostOfferMessageDto {
  @IsString() @MinLength(1) @MaxLength(2000) body: string;
}

const CLOSED: OfferStatus[] = [OfferStatus.EXPIRED, OfferStatus.WITHDRAWN];

// Conversation between a product's seller and the buyer who made an offer.
// Only those two can read or write it.
@Injectable()
export class OfferMessagesService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  private async assertParticipant(offerId: string, userId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { product: { select: { name: true, sellerId: true } } },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    const isBuyer = offer.buyerId === userId;
    const isSeller = offer.product.sellerId === userId;
    if (!isBuyer && !isSeller) throw new ForbiddenException('Access denied');
    return { offer, isBuyer, isSeller };
  }

  async list(offerId: string, userId: string) {
    await this.assertParticipant(offerId, userId);
    const rows = await this.prisma.offerMessage.findMany({
      where: { offerId },
      orderBy: { createdAt: 'asc' },
      take: 500,
      include: { sender: { select: { profile: { select: { fullName: true, businessName: true } } } } },
    });
    return rows.map(m => ({
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      senderId: m.senderId,
      senderName: m.sender?.profile?.businessName || m.sender?.profile?.fullName || 'User',
      mine: m.senderId === userId,
    }));
  }

  async post(offerId: string, userId: string, dto: PostOfferMessageDto) {
    const { offer, isBuyer } = await this.assertParticipant(offerId, userId);
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Message cannot be empty');
    if (CLOSED.includes(offer.status as OfferStatus)) {
      throw new BadRequestException('This offer is closed, so the conversation is read-only.');
    }
    const created = await this.prisma.offerMessage.create({ data: { offerId, senderId: userId, body } });
    await this.notifications.notify({
      userId: isBuyer ? offer.product.sellerId : offer.buyerId,
      type: NotificationType.OFFER_RECEIVED,
      title: `New message about ${offer.product.name}`,
      body: body.length > 120 ? body.slice(0, 117) + '…' : body,
      data: { link: isBuyer ? '/seller' : '/buyer', offerId },
    });
    return created;
  }
}
