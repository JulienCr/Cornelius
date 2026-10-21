# Carte graphique (GPU)

Cornelius fonctionne sans carte graphique. Deux fonctions facultatives en profitent : la vision locale et la génération d’images. Cette page indique quel matériel convient, comment l’installer sous Linux et Windows, et comment vérifier qu’il sert vraiment.

## Ce qui profite d’un GPU

- **La vision locale** (modèle LFM2.5-VL, calculé par ONNX Runtime) : Cornelius décrit plus vite ce qu’il voit, et les versions 1,6B et 3B deviennent utilisables.
- **La génération d’images** (calculée par PyTorch) : sans GPU, une image prend beaucoup de temps, surtout avec les gros modèles.

Le reste tourne toujours sur le processeur : la détection et la reconnaissance des visages, la détection de la voix et le mot d’appel. La conversation et la mémoire passent par OpenAI.

## Quel matériel pour quoi

| Machine | Vision locale | Génération d’images |
|---|---|---|
| Carte NVIDIA, Linux ou Windows | ONNX Runtime CUDA, graphes fp16 | PyTorch 2.9.1 CUDA 13.0, choisi automatiquement |
| Radeon dédiée (RDNA 3 ou 4), Ubuntu 24.04 avec ROCm 7.2.1 | ONNX Runtime MIGraphX publié par AMD (`--gpu amd`) | PyTorch 2.9.1 ROCm 7.2.1, choisi automatiquement |
| Ryzen AI 9 HX 470 ou HX 370 (Radeon 890M, gfx1150), Ubuntu 24.04 avec ROCm 7.2.1 | Processeur : AMD ne prend pas en charge MIGraphX sur ces puces | PyTorch 2.9.1 ROCm 7.2.1, choisi automatiquement |
| Radeon ou Ryzen AI, Windows | DirectML (`onnxruntime-directml`) | Composants ROCm SDK 7.2.1 d’AMD, puis PyTorch 2.9.1 ROCm (Python 3.12, pilote AMD Software: Adrenalin Edition 26.2.2 ou plus récent) |
| GPU Intel, Windows | DirectML (`onnxruntime-directml`) | Processeur |
| Ryzen AI, Debian ou Arch | Processeur | Processeur conseillé (`CORNELIUS_IMAGE_BACKEND=cpu`) : AMD ne documente ROCm pour les Ryzen AI que sur Ubuntu 24.04 |
| Processeur seul | Processeur, graphes q4 | PyTorch pour processeur, lent pour les gros modèles |

Le NPU des processeurs Ryzen AI n’est pas utilisé par Cornelius.

## Vision locale

### Sous Linux

L’option `--gpu` de `scripts/install-linux.sh` choisit le moteur ONNX Runtime :

- `auto` (par défaut) : moteur NVIDIA si `nvidia-smi` répond, sinon processeur ;
- `nvidia` : `onnxruntime-gpu`, avec les bibliothèques CUDA fournies par pip (`perception/requirements-gpu.txt`) ;
- `amd` : `onnxruntime-migraphx` publié par AMD pour ROCm 7.2.1. ROCm doit être installé avant (dossier `/opt/rocm`). Réservé aux Radeon dédiées : sur un Ryzen AI, gardez `--gpu cpu` ;
- `cpu` : le moteur pour processeur seul.

Le script télécharge ensuite la version de la vision adaptée au moteur trouvé : graphes fp16 pour un GPU, q4 pour le processeur. Pour changer de moteur plus tard, relancez-le avec la nouvelle option, par exemple :

```sh
scripts/install-linux.sh --gpu nvidia --systemd
```

### Sous Windows

Les commandes sont dans [Installer sous Windows](windows.md#en-option--la-vision-sur-la-carte-graphique) : `perception\requirements-gpu.txt` pour NVIDIA, `onnxruntime-directml` pour AMD et Intel.

### Changer de moteur ONNX

Un seul moteur ONNX Runtime doit être installé dans `.venv` : `onnxruntime` (processeur), `onnxruntime-gpu` (NVIDIA), `onnxruntime-directml` (Windows) ou `onnxruntime-migraphx` (AMD sous Linux). Deux moteurs à la fois se gênent. Si la vision ne trouve plus le GPU, par exemple après une mise à jour qui a réinstallé `perception/requirements.txt`, retirez-les tous puis installez le bon.

Sous Linux, avec une carte NVIDIA :

```sh
.venv/bin/python -m pip uninstall -y onnxruntime onnxruntime-gpu onnxruntime-directml onnxruntime-migraphx
.venv/bin/python -m pip install -r perception/requirements-gpu.txt
.venv/bin/python perception/download_models.py --device auto
```

Sous Windows, avec une carte AMD ou Intel :

```powershell
.venv\Scripts\python -m pip uninstall -y onnxruntime onnxruntime-gpu onnxruntime-directml onnxruntime-migraphx
.venv\Scripts\python -m pip install onnxruntime-directml==1.24.4
.venv\Scripts\python perception\download_models.py --device auto
```

Pour revenir au processeur, installez `onnxruntime==1.30.0` à la place. Redémarrez ensuite Cornelius.

### Régler et vérifier

Dans l’administration, **Modules → Vision → Détails techniques → Calcul** propose trois choix :

- « Automatique, carte graphique si disponible » (par défaut) ;
- « Carte graphique (graphes fp16) » : le chargement échoue clairement si aucun moteur GPU n’est disponible ;
- « Processeur (graphes q4) ».

Ce choix l’emporte sur la variable `CORNELIUS_VISION_DEVICE`, qui ne donne que la valeur de départ. Le moteur réellement utilisé s’affiche dans **État du système → Description de la scène**, par exemple « GPU CUDA », « GPU DirectML » ou « CPU ». Pour imposer un moteur ou choisir une carte parmi plusieurs, utilisez `CORNELIUS_VISION_PROVIDER` et `CORNELIUS_VISION_DEVICE_ID` (voir [Configuration](../reference/configuration.md)).

Mémoire estimée par l’administration pour chaque version :

| Version | Processeur (q4) | Carte graphique (fp16) |
|---|---|---|
| 450M, « Léger » | environ 1 Go | environ 1,5 Go |
| 1,6B, « Équilibré » | environ 2,5 Go | environ 4 Go |
| 3B, « Précis » | environ 4 Go | environ 7 Go |

### La perception s’arrête juste après le démarrage (CUDA)

Symptôme : l’écran affiche « Le service caméra n’est pas lancé » et `perception.err.log` contient `No registered plugin EP device found for 'CUDAExecutionProvider'` ou un arrêt brutal (segfault).

- Le paquet `nvidia-cuda-runtime` doit rester en 13.0.96, comme dans `perception/requirements-gpu.txt`. Une version 13.1 ou plus plante avec certains pilotes. Pour corriger : `.venv/bin/python -m pip install -r perception/requirements-gpu.txt`.
- Sous WSL, le pilote vient de Windows. Retirez les paquets `libnvidia-compute-*` installés par apt dans WSL : leurs bibliothèques périmées masquent celles de Windows.
- Après une mise à jour du pilote Windows, lancez `wsl --shutdown` puis rouvrez WSL.

Cornelius teste le GPU dans un processus séparé avant de l’utiliser. Si ce test échoue, le mode automatique passe sur le processeur et le mode « Carte graphique » signale l’erreur. Le résultat est écrit une fois dans le journal de la perception (`[vision] test ...`).

## Génération d’images

### Installation

Tout se fait depuis l’administration, dans **Modules → Génération d’image** : choisir le modèle, l’installer, puis l’activer. L’installateur (`image_generation/install.py`) :

1. crée un environnement Python séparé, `.venv-image`, pour ne pas toucher à celui de la perception ;
2. détecte la carte graphique : NVIDIA avec `nvidia-smi`, AMD par l’identifiant PCI `0x1002` sous Linux ou par le nom de la carte sous Windows ;
3. installe PyTorch 2.9.1 dans la bonne variante : CUDA 13.0 pour NVIDIA, ROCm 7.2.1 pour AMD, sinon la version pour processeur. Sous Linux, une carte AMD n’est utilisée que si le périphérique `/dev/kfd` existe, signe que ROCm est en place ; sinon l’installation reste sur le processeur, avec un message. Sous Windows, il installe d’abord les composants ROCm SDK d’AMD, puis PyTorch, dans l’ordre de la documentation d’AMD. Un PyTorch déjà installé dans la bonne variante est gardé ;
4. installe les autres dépendances, aux versions fixées dans `image_generation/requirements.txt` ;
5. télécharge le modèle depuis Hugging Face.

Si PyTorch est installé mais que la carte reste inaccessible, l’installation échoue avec un message : vérifiez le pilote (ROCm pour AMD), ou imposez le processeur avec `CORNELIUS_IMAGE_BACKEND=cpu`.

L’installateur est lancé avec le Python indiqué par `CORNELIUS_PYTHON`, sinon celui de `.venv`, sinon `python3` (`python` sous Windows). La variante ROCm exige Python 3.12, celui de `.venv`.

### Mémoire et placement du modèle

| Modèle | Mémoire graphique | Disque |
|---|---|---|
| SDXL Turbo, « Léger » | environ 7 Go | environ 7 Go |
| SANA-Sprint 0.6B, « Équilibré » | environ 9 Go | environ 9 Go |
| FLUX.2 Klein 4B, « Précis » | environ 13 Go | environ 16 Go |
| Z-Image Turbo, « Très précis » | environ 20 Go | environ 43 Go (31 Go téléchargés) |

Au chargement, le générateur compare le poids du modèle à la mémoire graphique libre, avec une marge de 3,5 Go :

1. si tout tient, le modèle est entièrement en mémoire graphique ;
2. sinon, si une version allégée tient, une partie des poids est stockée en FP8 (un octet au lieu de deux) ;
3. sinon, les éléments du modèle passent en mémoire graphique l’un après l’autre (déchargement vers le processeur), ce qui est plus lent.

Le placement retenu s’affiche une fois le modèle chargé, dans **État du système → Génération d’image** et sous les réglages de **Modules → Génération d’image**.

### Variables utiles

Ces variables se placent dans `.env`. Après une modification, redémarrez Cornelius. Pour une variable qui change la variante de PyTorch, cliquez ensuite sur **Vérifier l’installation** à l’étape « Installer » de **Modules → Génération d’image**.

| Variable | Effet |
|---|---|
| `CORNELIUS_IMAGE_BACKEND` | Variante de PyTorch : `auto` (par défaut), `cuda`, `rocm` ou `cpu`. |
| `CORNELIUS_TORCH_VERSION`, `CORNELIUS_TORCH_INDEX_URL` | Autre version de PyTorch (2.9.1 par défaut) ou autre dépôt de paquets. |
| `CORNELIUS_PYTHON` | Python qui crée `.venv-image`. |
| `CORNELIUS_IMAGE_DEVICE` | Calcul : `auto` (par défaut), `cuda` (NVIDIA, ou AMD avec ROCm), `mps` (Mac) ou `cpu`. |
| `CORNELIUS_IMAGE_VRAM_GB` | Mémoire graphique à compter, en Go, au lieu de celle mesurée par PyTorch. |
| `CORNELIUS_IMAGE_CPU_OFFLOAD` | `auto` (par défaut) selon la mémoire, `1` impose le déchargement vers le processeur, `0` tout en mémoire graphique. |
| `CORNELIUS_IMAGE_FP8` | `0` écarte l’étape FP8. |

La liste complète est dans [Configuration](../reference/configuration.md).

## Installer ROCm sur Ubuntu 24.04

Les commandes ci-dessous suivent la page « Install Ryzen Software for Linux with ROCm » de la documentation d’AMD « Use ROCm on Radeon and Ryzen » (version 7.2.1). Pour une Radeon dédiée, suivez plutôt la page Radeon de la même documentation. Les Ryzen AI demandent le noyau OEM 6.14-1018 ou plus récent :

```sh
sudo apt update
sudo apt install linux-oem-24.04c
# redémarrez, puis vérifiez le noyau avec : uname -r
wget https://repo.radeon.com/amdgpu-install/7.2.1/ubuntu/noble/amdgpu-install_7.2.1.70201-1_all.deb
sudo apt install ./amdgpu-install_7.2.1.70201-1_all.deb
sudo amdgpu-install -y --usecase=rocm --no-dkms
sudo usermod -aG render,video "$USER"
# redémarrez l’ordinateur
```

L’option `--no-dkms` est indispensable sur un Ryzen AI : ROCm y utilise le pilote déjà fourni par le noyau. Après le redémarrage, `rocminfo` doit lister `gfx1150` sur un Ryzen AI 9 HX 470, et le périphérique `/dev/kfd` doit exister.

Ensuite :

- pour les images, cliquez sur **Vérifier l’installation** dans **Modules → Génération d’image** : la variante ROCm est choisie toute seule ;
- pour la vision sur une Radeon dédiée, relancez `scripts/install-linux.sh --gpu amd` (avec `--systemd` si vous utilisez les services).

## Ryzen AI 9 HX 470 avec 32 Go

La Radeon 890M n’a pas de mémoire propre : elle partage les 32 Go avec le système, le navigateur, le serveur et la vision. Repères :

- **Vision** : la version 450M sur le processeur. La 1,6B est possible mais plus lente ; la 3B est déconseillée.
- **Images** : SDXL Turbo (environ 7 Go) ou SANA-Sprint 0.6B (environ 9 Go). FLUX.2 Klein 4B (environ 13 Go) peut tenir grâce au stockage FP8. Z-Image Turbo (environ 20 Go) est déconseillé.
- **Sous Linux**, la carte peut emprunter de la mémoire au système, en plus de la réserve fixée dans le BIOS (« UMA Frame Buffer Size »). ROCm peut pourtant ne compter que cette réserve : si le générateur choisit le déchargement vers le processeur alors que la mémoire suffit, indiquez le budget dans `.env`, par exemple `CORNELIUS_IMAGE_VRAM_GB=14`, ou imposez tout en mémoire graphique avec `CORNELIUS_IMAGE_CPU_OFFLOAD=0`. Si le stockage FP8 échoue avec ROCm, ajoutez `CORNELIUS_IMAGE_FP8=0`.
- **Sous Windows**, la réserve de la carte se règle dans AMD Software: Adrenalin Edition (« Variable Graphics Memory », jusqu’à 75 % de la mémoire). Avec 32 Go, une réserve de 16 Go laisse 16 Go au système et suffit pour SDXL Turbo, SANA-Sprint et FLUX.2 Klein en FP8.

## Conseils

- Commencez sans GPU : la vision 450M sur le processeur suffit pour décrire une scène.
- Quand Cornelius regarde à la demande, il attend la description 10 secondes au plus. Les versions 1,6B et 3B peuvent dépasser ce délai sur le processeur : choisissez-les seulement avec un GPU.
- Si la vision et les images partagent la même carte, gardez la vision en 450M ou sur le processeur, et activez **Charger le modèle dès le démarrage** dans **Modules → Génération d’image** : la première image ne paie plus le chargement, mais la mémoire reste occupée en permanence.
- La compatibilité ne dit rien de la vitesse. Mesurez sur votre machine : `pnpm mesures` donne la durée médiane des analyses de la vision, et **État du système → Génération d’image** la dernière génération. Sur AMD, vérifiez aussi la mémoire réellement disponible pour la carte.

## Voir aussi

- [Installer sous Linux](linux.md)
- [Installer sous Windows](windows.md)
- [Vision locale](../fonctionnalites/vision-locale.md)
- [Génération d’images](../fonctionnalites/generation-d-images.md)
- [Configuration](../reference/configuration.md)
- [Licences](../reference/licences.md)
