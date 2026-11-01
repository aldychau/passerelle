# Passerelle

Application gratuite et au code ouvert (MIT), installée sur le PC du vendeur. Elle ouvre une interface dans votre navigateur et fait deux choses : extraire vos boutiques Etsy vers le Studio, importer les fiches et suivis du Studio vers Etsy. Aucun compte Passerelle, abonnement, paiement, IA ou suivi d’usage. API Etsy officielle uniquement, aucune lecture de pages Etsy.

## Démarrer sur Windows

1. Installez **Node.js 24** avec son installateur Windows, en conservant les options proposées. Rouvrez votre session si Windows ne reconnaît pas Node.
2. Téléchargez et décompressez le dépôt dans un dossier où vous pouvez écrire. Si les dépendances manquent, le lanceur les installe automatiquement avec `npm ci` : une connexion Internet est nécessaire au premier lancement.
3. Double-cliquez sur **Lancer.bat**. Au premier lancement, ou après une modification, il construit l’application. Le navigateur s’ouvre sur **http://127.0.0.1:3030**. Gardez la fenêtre du lanceur ouverte ; Ctrl+C arrête l’application.
4. Dans **Boutiques**, suivez les étapes pour créer votre propre application sur Etsy Developers. Collez la Keystring et le Shared Secret, ajoutez la boutique puis autorisez la connexion sur Etsy. L’approbation d’Etsy peut être nécessaire. Adresse de rappel exacte : `http://127.0.0.1:3030/oauth/etsy/callback`.
5. Pour importer des fiches physiques, choisissez les profils d’expédition et de préparation avec **Profils des brouillons**. Ces profils doivent exister dans votre boutique Etsy. La catégorie, le fabricant et la période de fabrication se renseignent dans le Studio.

**Extraire** permet de choisir une boutique ou toutes et une période (30 jours par défaut). Après récupération des commandes, annonces, opérations et vues du jour, `boutique.zip` est téléchargé. Il contient des adresses de clients : gardez-le privé. Le relevé contient tout l’historique connu, indépendamment de la période choisie.

**Importer** accepte un zip du Studio, affiche un aperçu puis demande confirmation. Les fiches créent ou modifient uniquement des **brouillons**, jamais une publication. Les suivis confirmés peuvent prévenir l’acheteur via Etsy. Les variantes, images et traductions sont reprises ; les vidéos sont refusées explicitement. Une fiche déjà publiée est ignorée. Les fichiers plus anciens ne remplacent pas les imports plus récents. Le journal détaille les succès et échecs.

Si une création ou un suivi a une réponse réseau incertaine, Passerelle évite de renvoyer automatiquement l’écriture. Vérifiez Etsy avant de réessayer. Une référence de création incertaine reste bloquée pour éviter les doublons ; sa résolution manuelle dans la base nécessite une personne compétente. Les boutiques sont reliées au Studio par leur nom : utilisez le même nom des deux côtés.

## Données et sécurité

PGlite conserve les données en fichiers dans `%LOCALAPPDATA%\Passerelle`. La variable `PASSERELLE_DATA` change ce dossier ; `memory://` sert aux tests. Sauvegardez le dossier complet application arrêtée, y compris `secret.key` : sa perte rend les accès Etsy illisibles. Ne partagez pas cette sauvegarde. Supprimer une boutique efface ses données locales, sans supprimer la boutique Etsy. Déconnecter efface les jetons locaux ; révoquez aussi l’application dans Etsy pour supprimer son autorisation côté Etsy.

Clés et jetons sont chiffrés par AES-256-GCM (`SecretBox`), avec une clé dans un fichier séparé de la base. **Ce chiffrement protège contre une copie de la base seule, pas contre un logiciel malveillant sur le PC**, ni contre une copie simultanée de la base et de la clé. Aucun secret n’est journalisé ni exporté. Les adresses sont effacées lors de la récupération d’une commande expédiée, annulée ou remboursée, ou dès l’import de son état expédié/annulé. L’application doit tourner et relire Etsy pour connaître une modification distante.

Le serveur écoute uniquement `127.0.0.1:3030`, vérifie Host, Origin et CSRF, et applique une CSP sans ressources distantes. Aucun appel applicatif hors de l’API Etsy et de ses pages OAuth ; les liens Developers sont ouverts à votre demande. Les images d’annonces ne sont pas chargées par l’interface. Le service reste accessible aux logiciels du PC ; gardez votre session Windows protégée.

Dépannage : si le port est occupé, fermez l’autre instance ; si Etsy refuse l’accès, vérifiez les clés, l’approbation et l’adresse de rappel puis reconnectez. Les limites Etsy ou une coupure interrompent l’extraction sans fournir de zip partiel. Aucun installateur autonome ni mise à jour automatique n’est fourni.

## Développement et formats

Monorepo npm : `shared` (contrats zod), `server` (Fastify, PGlite), `web` (React). `npm run typecheck` et `npm test` vérifient les types, les imports/exports et les protections avec Etsy simulé. Aucun vrai compte requis pour les tests. Voir [docs/FORMAT.md](docs/FORMAT.md). Les schémas `echange.ts` sont compatibles avec le Studio. `shared/src/releve.ts` correspond exactement au fichier du Studio lors du dernier contrôle. Les deux copies doivent rester identiques. Ce dépôt ne modifie pas le Studio.

The term 'Etsy' is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by Etsy, Inc.

---

# Passerelle — English

Free, MIT-licensed software running on the seller’s Windows PC. It opens your shops in a browser and exchanges files with Studio. No Passerelle account, subscription, payments, AI, telemetry or Etsy page scraping. Only the official Etsy API is used.

## Install and use

1. Install **Node.js 24** for Windows with its default options.
2. Download and unzip the repository into a writable folder. When dependencies are missing, the launcher installs them with `npm ci`; the first launch requires Internet access.
3. Double-click **Lancer.bat**. It builds when needed, starts the local server and opens **http://127.0.0.1:3030**. Keep its window open. Press Ctrl+C to stop.
4. Follow the French **Boutiques** screen to register your own Etsy application, enter your Keystring and Shared Secret and connect using OAuth with PKCE. Etsy approval may be required. Register exactly `http://127.0.0.1:3030/oauth/etsy/callback` as the callback URL.
5. Choose existing shipping and processing profiles in **Profils des brouillons** before importing physical drafts. Studio must provide category, maker and production period.

**Extraire** downloads `boutique.zip` after fetching orders, listings, ledger entries and today’s views. The default order period is 30 days; the ledger always includes all known history. **The zip contains customer addresses: keep it private.** **Importer** validates a Studio zip, shows a preview and requires confirmation. Listings are created or updated as drafts only; tracking may notify buyers through Etsy. Images, variations and translations are supported; videos are explicitly refused. Published listings are skipped. Older imports cannot overwrite newer ones. Uncertain creations remain blocked to prevent duplicates and require manual reconciliation with Etsy; uncertain tracking is not automatically sent twice.

Data lives in `%LOCALAPPDATA%\Passerelle`; override with `PASSERELLE_DATA` (`memory://` in tests). Back up the whole folder while stopped, including `secret.key`. Losing this key makes stored Etsy credentials unreadable. AES-256-GCM protects against copying the database alone, **not malware on the PC**, nor copying both the database and key. Secrets are never logged or exported. Buyer contact details are purged when shipped, cancelled or refunded orders are fetched, or when a shipped/cancelled Studio state is imported. Remote changes require another fetch.

The server binds only to `127.0.0.1:3030`, validates Host/Origin/CSRF and uses a local-only CSP. No remote fonts, images or analytics are loaded. Protect your Windows session. Disconnecting clears local tokens; revoke the app on Etsy to remove its remote authorization. Deleting a shop removes local data only. If the port is busy, close the other instance. Reconnect after checking credentials, approval and callback URL when Etsy rejects access. No standalone installer or automatic updater is included.

Run `npm run typecheck` and `npm test` for validation with mocked Etsy. File specifications: [docs/FORMAT.md](docs/FORMAT.md). `shared/src/releve.ts` matches the Studio copy at verification time; both copies must remain identical. This repository does not modify Studio.

The term 'Etsy' is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by Etsy, Inc.
