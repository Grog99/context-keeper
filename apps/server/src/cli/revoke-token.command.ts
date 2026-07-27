import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';

/** Unieważnienie natychmiastowe (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") —
 * odrębne od `rotate-token` (graceful, nakładka stary+nowy): tu stary token przestaje działać
 * NATYCHMIAST, bez zamiennika. Użyj dla skompromitowanego credentiala. Id z: `list-tokens <projectId>`. */
@Command({
  name: 'revoke-token',
  arguments: '<tokenId>',
  description: 'Unieważnia token NATYCHMIAST i nieodwracalnie (bez okresu karencji). Id z: list-tokens <projectId>.',
})
export class RevokeTokenCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const tokenId = inputs[0]?.trim();
    if (!tokenId) {
      throw new Error('Podaj id tokena: revoke-token <tokenId> (patrz: list-tokens <projectId>)');
    }
    console.log('');
    console.log('UWAGA: unieważnienie jest natychmiastowe i nieodwracalne — bez okresu karencji.');
    const revoked = await this.projects.revokeToken(tokenId);
    console.log(`Token ${revoked.id} (etykieta "${revoked.label}") — status: ${revoked.status}.`);
    console.log('');
  }
}
