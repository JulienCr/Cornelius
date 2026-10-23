import type { MirrorState } from '../../../shared/types';
import { api } from '../../api';
import type { RunAction } from './types';
import { Field, OwnerSelect } from './shared';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card';

export function DefaultProfile({ state, run }: { state: MirrorState; run: RunAction }) {
  const value = state.defaultProfileId ?? '';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profil par défaut</CardTitle>
        <CardDescription>
          Quand personne n’est reconnu, la conversation se déroule au nom de ce profil. Une personne
          reconnue par la caméra reste prioritaire.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field
          id="default-profile"
          label="Conversations au nom de"
          help={
            value
              ? 'Quiconque parle seul devant le miroir accède à la mémoire de cette personne. Devant plusieurs personnes, le miroir revient au foyer.'
              : 'Le foyer : tout le monde, sans mémoire personnelle.'
          }
        >
          <OwnerSelect
            id="default-profile"
            value={value}
            profiles={state.profiles}
            onChange={(next) => {
              void run('Profil par défaut enregistré.', () => api.defaultProfile(next || null));
            }}
          />
        </Field>
      </CardContent>
    </Card>
  );
}
