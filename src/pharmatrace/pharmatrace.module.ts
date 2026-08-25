import { Global, Module } from '@nestjs/common';
import { KeycloakAuthService } from './keycloak-auth.service';
import { PharmaTraceGraphqlService } from './pharmatrace-graphql.service';
import { PharmaTraceNormalizerService } from './pharmatrace-normalizer.service';

@Global()
@Module({
  providers: [
    KeycloakAuthService,
    PharmaTraceNormalizerService,
    PharmaTraceGraphqlService,
  ],
  exports: [
    KeycloakAuthService,
    PharmaTraceNormalizerService,
    PharmaTraceGraphqlService,
  ],
})
export class PharmaTraceModule {}
