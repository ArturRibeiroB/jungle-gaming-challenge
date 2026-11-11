import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (seção 2 do desafio). Hoje deixa tudo passar.
 *
 * Desenho previsto (detalhado no ARCHITECTURE.md): cada provedor é um client OIDC no
 * Keycloak e obtém um access token via client credentials. Este guard validaria a
 * assinatura do JWT pelo JWKS do realm (iss, aud, exp), extrairia o client id (`azp`)
 * como providerId e recusaria com 403 qualquer requisição cujo `providerId` no corpo
 * ou na rota seja diferente. Endpoints de health não usam o guard.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
