import { Global, Module } from '@nestjs/common';
import { KeycloakAuthService } from './keycloak-auth.service';
import { PharmaTraceGraphqlService } from './pharmatrace-graphql.service';
import { PharmaTraceNormalizerService } from './pharmatrace-normalizer.service';
import { LotAnchorService } from './lot-anchor.service';

@Global()
@Module({
  providers: [
    KeycloakAuthService,
    PharmaTraceNormalizerService,
    PharmaTraceGraphqlService,
    LotAnchorService,
  ],
  exports: [
    KeycloakAuthService,
    PharmaTraceNormalizerService,
    PharmaTraceGraphqlService,
    LotAnchorService,
  ],
})
export class PharmaTraceModule {}
