# Passerelle

[Guide : connecter ta boutique Etsy](docs/CONNECTER-SA-BOUTIQUE.md) · [Connection guide (French)](docs/CONNECTER-SA-BOUTIQUE.md)

Application gratuite et au code ouvert (MIT), installée sur le PC du vendeur. Elle ouvre une interface dans votre navigateur et fait deux choses : extraire vos boutiques Etsy vers le Studio, importer les fiches et suivis du Studio vers Etsy. Aucun compte Passerelle, abonnement, paiement, IA ou suivi d’usage. API Etsy officielle uniquement, aucune lecture de pages Etsy.

## Démarrer sur Windows

1. Installez **Node.js 24** avec son installateur Windows, en conservant les options proposées. Rouvrez votre session si Windows ne reconnaît pas Node.
2. Téléchargez et décompressez le dépôt dans un dossier où vous pouvez écrire. Si les dépendances manquent, le lanceur les installe automatiquement avec `npm ci` : une connexion Internet est nécessaire au premier lancement.
3. Double-cliquez sur **Lancer.bat**. Au premier lancement, ou après une modification, il construit l’application. Le navigateur s’ouvre sur **https://localhost:3030**. Gardez la fenêtre du lanceur ouverte ; Ctrl+C arrête l’application.

Au premier accès sur https://localhost:3030 le navigateur peut afficher « Votre connexion n’est pas privée » : le certificat est auto-signé. C’est normal, le serveur est sur ton PC. Clique sur « Paramètres avancés » puis « Continuer vers localhost ».

4. Dans **Boutiques**, suivez les étapes pour créer votre propre application sur Etsy Developers. Collez la Keystring et le Shared Secret, ajoutez la boutique puis autorisez la connexion sur Etsy. L’approbation d’Etsy peut être nécessaire. Adresse de rappel exacte : `https://localhost:3030/oauth/etsy/callback`.
5. Pour importer des fiches physiques, choisissez les profils d’expédition et de préparation avec **Profils des brouillons**. Ces profils doivent exister dans votre boutique Etsy. La catégorie, le fabricant et la période de fabrication se renseignent dans le Studio.

**Une boutique pour l’instant** : Passerelle accepte une seule boutique, et chaque extraction porte sur elle. Plusieurs boutiques arriveront avec l’abonnement Studio. Pour changer de boutique, supprime-la dans Boutiques puis ajoute la nouvelle.

**Extraire** permet de choisir la période (30 jours par défaut). Après récupération des commandes, annonces, opérations et vues du jour, `boutique.zip` est téléchargé. Le catalogue optionnel contient descriptions, matériaux, SKU, variantes, images, sections, profils et notes des avis sans identité ni texte libre. Le fichier pour le Studio (téléchargement et envoi direct) contient aussi le catalogue, sans aucune coordonnée d'acheteur : le Studio connaît ainsi toutes les variantes en vente (tailles, couleurs…) pour lier chacune à AliExpress. Un catalogue que le Studio refuserait est laissé de côté et le journal le dit ; voir [FORMAT.md](docs/FORMAT.md). Il contient des adresses de clients : gardez-le privé. Le relevé contient tout l’historique connu, indépendamment de la période choisie.

**Envoi au Studio (facultatif)** : dans le Studio, Réglages → « Passerelle : envoi direct », crée une clé. Dans Passerelle, écran Extraire, colle l’adresse du Studio, l’identifiant (`stk_…`) et le secret (`sts_…`). Chaque extraction est alors envoyée directement au Studio, sans téléchargement ; « Renvoyer au Studio » la renvoie. Le secret est chiffré comme les clés Etsy. L’adresse doit être en HTTPS (sauf un Studio sur ce PC), les redirections sont refusées. Sans réglage, Passerelle ne contacte que l’API Etsy.

**Importer un fichier du Studio** valide le zip et affiche les brouillons et suivis prévus. **Enregistrer en attente** conserve les éléments sur ton PC sans écriture Etsy. **Synchroniser avec Etsy (N)** envoie ensuite la file persistante, avec progression et résultat par ligne. Après une coupure, relance la synchronisation ; les réussites ne sont pas rejouées. Les fiches créent ou modifient uniquement des **brouillons**, jamais une publication. Les suivis confirmés peuvent prévenir l’acheteur via Etsy. Les variantes, images et traductions sont reprises ; les vidéos sont refusées explicitement. Une fiche déjà publiée est ignorée. Les fichiers plus anciens ne remplacent pas les imports plus récents. Le journal détaille les succès et échecs.

Si une création ou un suivi a une réponse réseau incertaine, Passerelle évite de renvoyer automatiquement l’écriture. Vérifiez Etsy avant de réessayer. Une référence de création incertaine reste bloquée pour éviter les doublons ; sa résolution manuelle dans la base nécessite une personne compétente. Les boutiques sont reliées au Studio par leur nom : utilisez le même nom des deux côtés.

Avant publication publique, remplace l’adresse d’exemple dans [SECURITY.md](SECURITY.md). Les signalements de faille se font en privé. Ne joins jamais de clé ou donnée client aux issues.

## Données et sécurité

PGlite conserve les données en fichiers dans `%LOCALAPPDATA%\Passerelle`. La variable `PASSERELLE_DATA` change ce dossier ; `memory://` sert aux tests. Sauvegardez le dossier complet application arrêtée, y compris `secret.key` : sa perte rend les accès Etsy illisibles. Ne partagez pas cette sauvegarde. Supprimer une boutique efface ses données locales, sans supprimer la boutique Etsy. Déconnecter efface les jetons locaux ; révoquez aussi l’application dans Etsy pour supprimer son autorisation côté Etsy.

Clés et jetons sont chiffrés par AES-256-GCM (`SecretBox`), avec une clé dans un fichier séparé de la base. **Ce chiffrement protège contre une copie de la base seule, pas contre un logiciel malveillant sur le PC**, ni contre une copie simultanée de la base et de la clé. Aucun secret n’est journalisé ni exporté. Nom, adresse, e-mail, téléphone et message sont conservés uniquement pour les commandes payées, non expédiées, non annulées et sans remboursement. Identifiants d’acheteur et notes ne sont pas conservés. Les coordonnées sont effacées lors de la récupération d’une commande expédiée, annulée ou remboursée, ou dès l’import de son état expédié/annulé. L’application doit tourner et relire Etsy pour connaître une modification distante.

Le serveur écoute uniquement `127.0.0.1:3030`, vérifie Host, Origin et CSRF, et applique une CSP sans ressources distantes. Aucun appel applicatif hors de l’API Etsy et de ses pages OAuth, et de ton Studio si tu as réglé l’envoi direct ; les liens Developers sont ouverts à votre demande. Les images d’annonces ne sont pas chargées par l’interface. Le service reste accessible aux logiciels du PC ; gardez votre session Windows protégée.

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
3. Double-click **Lancer.bat**. It builds when needed, starts the local server and opens **https://localhost:3030**. Keep its window open. Press Ctrl+C to stop.
On the first visit, the browser may show "Your connection is not private" because the certificate is self-signed. This is normal: the server runs on your PC. Click "Advanced" then "Proceed to localhost" ("Paramètres avancés" then "Continuer vers localhost" in French).

4. Follow the French **Boutiques** screen to register your own Etsy application, enter your Keystring and Shared Secret and connect using OAuth with PKCE. Etsy approval may be required. Register exactly `https://localhost:3030/oauth/etsy/callback` as the callback URL.
5. Choose existing shipping and processing profiles in **Profils des brouillons** before importing physical drafts. Studio must provide category, maker and production period.

**Extraire** downloads `boutique.zip` after fetching orders, listings, ledger entries and today’s views. An optional catalogue contains listing details, inventory, images, shop sections, shipping profiles and review ratings without buyer identity or free text. Use **Télécharger pour le Studio (contrat version 1)** for the strict Studio reader: this download contains the two original JSON files only. The Studio file also carries the catalogue, without any buyer contact details, so Studio knows every variant for sale and can link each one to AliExpress. The default order period is 30 days; the ledger always includes all known history. **The zip contains customer addresses: keep it private.** **Import a Studio file** validates a zip and shows the planned drafts and tracking numbers. Saving the preview queues it locally without Etsy writes. **Synchroniser avec Etsy (N)** sends the persistent queue, with progress and per-item results. Resume after interruption; completed items are not replayed. Listings are created or updated as drafts only; tracking may notify buyers through Etsy. Images, variations and translations are supported; videos are explicitly refused. Published listings are skipped. Older imports cannot overwrite newer ones. Uncertain creations remain blocked to prevent duplicates and require manual reconciliation with Etsy; uncertain tracking is not automatically sent twice.

Before public release, replace the example reporting address in [SECURITY.md](SECURITY.md). Report vulnerabilities privately and never attach keys or customer data to issues.

Data lives in `%LOCALAPPDATA%\Passerelle`; override with `PASSERELLE_DATA` (`memory://` in tests). Back up the whole folder while stopped, including `secret.key`. Losing this key makes stored Etsy credentials unreadable. AES-256-GCM protects against copying the database alone, **not malware on the PC**, nor copying both the database and key. Secrets are never logged or exported. Only paid, unshipped, uncancelled orders without refunds retain buyer names, addresses, email, phone and messages. Buyer IDs and notes are never stored. Buyer contact details are purged when shipped, cancelled or refunded orders are fetched, or when a shipped/cancelled Studio state is imported. Remote changes require another fetch.

The server binds only to `127.0.0.1:3030`, validates Host/Origin/CSRF and uses a local-only CSP. No remote fonts, images or analytics are loaded. Protect your Windows session. Disconnecting clears local tokens; revoke the app on Etsy to remove its remote authorization. Deleting a shop removes local data only. If the port is busy, close the other instance. Reconnect after checking credentials, approval and callback URL when Etsy rejects access. No standalone installer or automatic updater is included.

Run `npm run typecheck` and `npm test` for validation with mocked Etsy. File specifications: [docs/FORMAT.md](docs/FORMAT.md). `shared/src/releve.ts` matches the Studio copy at verification time; both copies must remain identical. This repository does not modify Studio.

The term 'Etsy' is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by Etsy, Inc.
