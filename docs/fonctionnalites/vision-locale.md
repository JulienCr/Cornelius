# La vision locale

Cette page explique comment Cornelius décrit ce qui se trouve devant le miroir : le principe, l’installation du modèle, les réglages et la façon de vérifier que tout fonctionne. Elle s’adresse à la personne qui règle le miroir pour la maison.

## Le principe

La caméra du miroir sert d’abord à voir et reconnaître les personnes. La vision locale ajoute une autre capacité : décrire la scène, par exemple un objet que l’on montre, sa couleur ou un texte à lire.

Cette description est calculée sur l’ordinateur du miroir par un modèle d’analyse d’image, LFM2.5-VL, publié par Liquid AI. Aucune image ne quitte la machine. Seul le texte de la description rejoint la conversation, et donc OpenAI, comme le reste de ce qui se dit.

La vision est réglée pour tout le foyer : le modèle et le moment où Cornelius regarde valent pour tous les profils.

## Quand Cornelius regarde

Le réglage **Modules → Vision → Quand regarder** propose trois choix :

- **Au début de la conversation, puis sur demande** (par défaut) : Cornelius regarde une seconde après le début de la conversation, puis à chaque question sur ce qu’il voit. La personne n’a pas besoin de regarder le miroir.
- **Uniquement sur demande** : pas de regard au début. Cornelius ne regarde que lorsqu’on lui pose une question sur ce qu’il voit.
- **Jamais** : Cornelius ne décrit rien. La reconnaissance des personnes continue de fonctionner.

La description du début de la conversation est donnée à Cornelius en silence : il la connaît mais ne la récite pas. Changer ce réglage redémarre la conversation en cours, qui reprend avec le nouveau choix.

La carte **Vision** se trouve dans la rubrique **Modules**, groupe « Capacités de Cornelius ».

## Les trois modèles

| Choix | Modèle | Ce qu’il donne | Mémoire (processeur / GPU) | Disque (processeur / GPU) |
| --- | --- | --- | --- | --- |
| **Léger** (par défaut) | LFM2.5-VL 450M | Réponse rapide, description simple | environ 1 Go / 1,5 Go | environ 0,5 Go / 1 Go |
| **Équilibré** | LFM2.5-VL 1,6B | Plus de détails, encore rapide | environ 2,5 Go / 4 Go | environ 1,8 Go / 3,5 Go |
| **Précis** | LFM2.5-VL 3B | Les descriptions les plus fines, plus lent | environ 4 Go / 7 Go | environ 3,4 Go / 6,5 Go |

Ces chiffres sont les estimations affichées dans l’administration. Une description prend quelques secondes, selon le modèle et l’ordinateur. Sans carte graphique, le modèle **Léger** est le plus sûr : les deux autres risquent de dépasser le délai d’attente (voir plus bas).

## Calcul sur la carte graphique ou le processeur

Chaque modèle existe en deux versions : une pour la carte graphique (graphes « fp16 ») et une, plus compacte, pour le processeur (graphes « q4 »). Le réglage **Modules → Vision → Détails techniques → Calcul** choisit laquelle utiliser :

- **Automatique, carte graphique si disponible** (par défaut) : Cornelius cherche une carte graphique utilisable et prend la version GPU s’il en trouve une, sinon la version processeur.
- **Carte graphique (graphes fp16)** : impose la version GPU. Le chargement échoue clairement si aucune carte graphique n’est utilisable.
- **Processeur (graphes q4)** : impose la version processeur, même avec une carte graphique.

Changer de calcul peut télécharger l’autre version du modèle. Pour qu’une carte graphique soit utilisable, le bon moteur de calcul doit être installé dans l’environnement Python de la perception : voir [La carte graphique](../installation/gpu.md).

## Installer et activer le modèle

La carte **Vision** guide l’installation en trois étapes.

1. **Choisir le modèle** : cliquez sur **Léger**, **Équilibré** ou **Précis**. Ce choix ne télécharge rien. Un badge indique le modèle « Utilisé » et ceux déjà « Installé ».
2. **Installer** : cliquez sur **Installer « … »…**. Une confirmation indique la taille à télécharger et une durée estimée ; validez avec **Installer**. La progression s’affiche fichier par fichier. Vous pouvez quitter la page : l’installation continue sur le serveur, même si le service caméra est arrêté. Si un modèle est déjà installé, le bouton devient **Utiliser ce modèle**, et **Vérifier les fichiers** contrôle le modèle en place.
3. **Activer** : choisissez **Quand regarder**. Tant que le modèle n’est pas installé, seul **Jamais** est disponible.

Quelques règles utiles :

- Une seule installation à la fois.
- Chaque fichier est vérifié par son empreinte. En cas d’échec, **Réessayer** garde les fichiers déjà vérifiés et reprend le reste.
- À la fin de l’installation, le service caméra recharge le modèle tout seul. S’il est arrêté, le modèle sera chargé à son prochain démarrage.
- Les fichiers sont rangés sur le serveur, dans `models/`, avec la licence de chaque modèle.

On peut aussi préparer un modèle en ligne de commande, depuis le dossier de Cornelius. Le script `perception/download_models.py` accepte `--model 450m`, `1.6b` ou `3b`, et `--device auto`, `gpu` ou `cpu`. L’option `--vision-only` ne télécharge que le modèle de vision.

Sous Linux :

```sh
.venv/bin/python perception/download_models.py --vision-only --model 1.6b --device auto
```

Sous Windows :

```powershell
.venv\Scripts\python perception\download_models.py --vision-only --model 1.6b --device auto
```

Le choix fait dans l’administration reste celui que Cornelius utilise.

## Poser une question sur ce qu’il voit

Il suffit de demander, par exemple « De quelle couleur est ma tasse ? » ou « Tu peux lire ce qui est écrit sur cette boîte ? ». Cornelius prend alors une nouvelle image et transmet au modèle une question précise, reformulée si besoin à partir de la conversation : « Et sa couleur ? » devient une question sur la couleur de la tasse dont on parlait. Une demande générale comme « Regarde » devient « Que vois-tu devant le miroir ? ».

Le modèle ne répond qu’à la question posée, sans inventaire de toute la scène. Si le détail est absent, caché, illisible ou ambigu, il le dit au lieu d’inventer. Cornelius peut alors demander de montrer l’objet plus clairement.

Pour une question de suivi sur la même image, Cornelius peut répondre avec ce qu’il a déjà reçu. Pour vérifier un changement ou un détail manquant, il reprend une image.

Une question posée pendant l’analyse du début de la conversation la remplace. Une seule question visuelle est traitée à la fois.

## Les délais

Ces délais sont fixés dans `server/vision.ts` :

- **1 seconde** : délai avant l’analyse du début de la conversation, une fois par conversation. C’est le moment où elle part, pas sa durée.
- **10 secondes** : durée de validité d’une description. Plus ancienne, elle est écartée.
- **10 secondes** : attente maximale d’une réponse à une question. Au-delà, Cornelius dit que la vision n’a pas pu répondre.
- **3 secondes** : avec « Cornelius » pour tout le monde, temps laissé à la caméra pour s’allumer et donner sa première image (voir la section suivante).

Une description est aussi écartée si la conversation change entre-temps : autre personne reconnue, regard perdu quand c’est le regard qui ouvre la conversation, fin de la conversation. Une analyse lente ne bloque ni la présence ni la voix.

## Avec « Cornelius » pour tout le monde

Quand la conversation s’ouvre au mot « Cornelius » pour tout le monde, la caméra reste éteinte en veille (voir [Ouverture et présence](ouverture-et-presence.md)). Si la vision est active, la caméra s’allume seulement pendant la conversation, puis s’éteint à sa fin. Avec **Jamais** et sans reconnaissance de la personne, elle reste éteinte même pendant la conversation.

La rubrique **Mise en route** demande donc de choisir une caméra dès que la vision est active, même dans ce cas.

## Vérifier que la vision fonctionne

La carte **État du système → Description de la scène** montre, sans rien modifier :

- le réglage **Quand regarder**, l’état du modèle (« Modèle prêt », « Chargement… », « Modèle absent ») et l’état du service caméra ;
- le moteur de calcul réellement utilisé, par exemple « GPU CUDA » ou « CPU » ;
- la durée de la dernière analyse, l’heure de la dernière demande et de la dernière image ;
- la dernière description, et les dix dernières analyses avec leur question, leur durée et leur résultat (« réussie », « échouée », « indisponible », « remplacée »).

Cet historique reste en mémoire et disparaît au redémarrage. Il n’est pas enregistré dans la base.

La carte **Modules → Vision → Détails techniques** reprend l’état du modèle, la version installée (GPU fp16 ou CPU q4) et le dernier message du service caméra.

Chaque analyse est aussi notée dans le journal des mesures, avec sa durée ou la raison de son échec, jamais la question ni la description. La commande suivante en donne la médiane, le p95 et les causes d’échec les plus fréquentes, séparément pour l’analyse du début et les questions :

```sh
pnpm mesures
```

Pour vérifier la caméra et les modèles sans lancer le serveur, `perception/worker.py --check` contrôle les fichiers ; ajoutez `--with-vision` pour charger vraiment le modèle (plus lent).

```sh
.venv/bin/python perception/worker.py --check --with-vision
```

```powershell
.venv\Scripts\python perception\worker.py --check --with-vision
```

Si une question échoue souvent par dépassement du délai, choisissez un modèle plus léger ou installez le calcul sur la carte graphique.

## Limites

- La qualité dépend de la lumière, de la distance et du modèle. Les petits textes restent difficiles à lire.
- Le modèle peut se tromper. Cornelius doit dire quand il n’est pas sûr, mais une erreur reste possible.
- La conversation vocale passe par OpenAI : sans elle, la vision ne sert pas.

## Voir aussi

- [Ouverture et présence](ouverture-et-presence.md)
- [La carte graphique](../installation/gpu.md)
- [L’administration](../utilisation/administration.md)
- [Dépannage](../utilisation/depannage.md)
- [Confidentialité](../reference/confidentialite.md)
- [Licences](../reference/licences.md)
