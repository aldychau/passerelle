# Formats Passerelle, version 1

Les fichiers d’échange sont des ZIP. Ils ne contiennent jamais de clé ou de jeton. Le schéma exécutable est dans `shared/src/echange.ts` (copie identique du Studio). Voir aussi [ECHANGE.md](ECHANGE.md) pour le contrat détaillé des fiches, suivis et boutiques. Les mentions historiques d’abonnement ou de compte dans ce document source ne s’appliquent pas à Passerelle.

## Export boutique.zip

- `echange.json` : `format: "atelier-echange"`, `version: 1`, `type: "boutique"`, `from: "etsy"`, `createdAt` en millisecondes, `periode`, `commandes`, `annonces`.
- `releve.json` : `format: "atelier-releve"`, `version: 1`, `createdAt` en millisecondes et `boutiques`.

`echange.json` contient les commandes payées non expédiées dans la période choisie et toutes les annonces. Les adresses de livraison ne voyagent que dans les commandes à préparer. `tout` part de l’ouverture ; `1m` soustrait un mois calendaire UTC en bornant le jour ; `30j`, `7j`, `1j` sont des durées glissantes. Valeur par défaut : `30j`. Maximum 5000 commandes et annonces au total, refus sans troncature. Un export sans commande ni annonce est refusé par le contrat Studio version 1.

`releve.json` porte tout l’historique connu des boutiques sélectionnées, sans filtre de période :

- Boutique : `shop` (nom de liaison au Studio), `currency`, `commandes`, `annonces`, `operations`, `vues`.
- Commande : `id`, `paidAt`, `t`, `status`, `paid`, `country`, `currency`, `totalPrice`, `subtotal`, `shipping`, `tax`, `discount`, `giftWrap`, `grandtotal`, `refunds: [{amount,t}]`, `shipped`, `items: [{id,listingId,sku,title,qty,price,variations}]`.
- Annonce : `id`, `title`, `state`, `price`, `quantity`, `url`, `views`, `favorites`, `image`, `tags`, `created`, `expires`.
- Opération : `id` (chaîne), `t`, `amount`, `currency`, `type`, `desc`, `refType`, `refId`.
- Vue : `day` (AAAA-MM-JJ, Europe/Paris), `listingId`, `views`, `favorites`.

`t`, `created`, `expires` sont en secondes Etsy ; `paidAt` et `createdAt` sont en millisecondes. Une date ou une mesure inconnue est `null`, pas un zéro inventé. URL d’annonce et d’image : HTTPS ou `null`. Il n’y a ni nom, adresse, ville, code postal, e-mail d’acheteur ni suivi dans le relevé. Aucun champ inconnu n’est accepté. Maximum 200 000 lignes (commandes + annonces + opérations + vues) et 100 Mo décompressés pour le relevé ; dépassement = refus entier.

Les vues sont relevées par annonce et par jour d’extraction. Relancer le même jour met à jour sa ligne ; une journée sans extraction reste absente. Les identifiants servent à mettre à jour, jamais à dupliquer ou supprimer. pour l’import Studio, un `createdAt` plus ancien ne doit remplacer aucune donnée plus récente. L’absence de `releve.json` dans un ancien zip doit être acceptée par le Studio en laissant sa comptabilité inchangée. L’import du relevé appartient au Studio, pas à Passerelle ; Les copies de `shared/src/releve.ts` sont identiques lors du dernier contrôle et doivent le rester.

## Imports du Studio

`fiches` et `suivis` utilisent une enveloppe `atelier-echange`, version 1, `from: "studio"`, `createdAt` et `items` (1 à 500). Chaque référence de fiche est stable (`st_…`) et liée à une seule boutique. Mise à jour uniquement tant que l’annonce Etsy est en brouillon. Les profils Etsy sont choisis dans Boutiques ; devise, fabricant, période et catégorie sont vérifiés. Les variantes, traductions et photos sont reprises. Les vidéos sont refusées par Passerelle. Les suivis ne sont posés que pour `envoye` avec un code et après confirmation. Les états ne reculent pas et un import ancien est ignoré. Les états sont conservés même si Etsy ne répond pas ; un envoi incertain n’est pas automatiquement répété.

Archives limitées à 200 Mo compressés et décompressés au total, JSON 20 Mo, images 20 Mo, 6000 entrées maximum. Les seuls chemins acceptés sont `echange.json`, `images/…` et les dossiers de médias prévus par le contrat. Chemins relatifs suspects, doublons, entrées imprévues, médias non référencés et JSON invalide sont refusés. Signatures JPEG/PNG/WebP vérifiées, pas seulement les extensions. Les références aux images absentes font refuser la fiche dans l’aperçu. Aucune extraction sur un chemin choisi par l’archive. Les fichiers sont conservés en mémoire pendant l’aperçu, qui expire après 30 minutes ; un nouvel aperçu remplace le précédent. Confirmation à usage unique. Chaque élément accepté est revérifié juste avant l’écriture ; un échec n’empêche pas le journal des autres éléments.
