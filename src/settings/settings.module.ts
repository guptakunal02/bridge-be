import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppSettingsService } from './app-settings.service';
import { AppSetting } from './entities/app-setting.entity';
import { SettingsController } from './settings.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AppSetting])],
  controllers: [SettingsController],
  providers: [AppSettingsService],
  // AppSettingsService exported so the email-inbox ingest path can
  // read the resolved-reopen window on each incoming message.
  exports: [AppSettingsService],
})
export class SettingsModule {}
