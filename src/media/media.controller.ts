import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query,
  UseGuards, UseInterceptors, UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { MediaService } from './media.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // GET /media/:entityType/:entityId — public, view a listing's photos/documents
  @Get(':entityType/:entityId')
  list(@Param('entityType') entityType: string, @Param('entityId') entityId: string) {
    return this.mediaService.list(entityType as any, entityId);
  }

  // POST /media/:entityType/:entityId — upload photos or documents (owner only)
  //
  // Round 2, Milestone 4: storage engine now configured at module level
  // (see media.module.ts) — see auth.module.ts for full reasoning.
  @Post(':entityType/:entityId')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 10))
  upload(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser('id') userId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Query('type') type: 'image' | 'document' = 'image',
  ) {
    return this.mediaService.upload(entityType as any, entityId, userId, files || [], type);
  }

  // PATCH /media/:id/set-primary — set as the display picture
  @Patch(':id/set-primary')
  @UseGuards(JwtAuthGuard)
  setPrimary(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.mediaService.setPrimary(id, userId);
  }

  // DELETE /media/:id
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.mediaService.remove(id, userId);
  }
}
