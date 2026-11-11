import { Global, Module, type DynamicModule } from '@nestjs/common';
import { AppConfig } from './app-config';

@Global()
@Module({})
export class ConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: AppConfig, useValue: config }],
      exports: [AppConfig],
    };
  }
}
