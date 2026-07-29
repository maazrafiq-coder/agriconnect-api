import { Module } from '@nestjs/common';
import { CitiesService, UnitsService } from './catalog.service';
import { CitiesController, UnitsController } from './catalog.controller';

@Module({
  controllers: [CitiesController, UnitsController],
  providers: [CitiesService, UnitsService],
  exports: [CitiesService, UnitsService],
})
export class CatalogModule {}
