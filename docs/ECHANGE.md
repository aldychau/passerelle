# Fichiers d'échange entre l'appli Etsy et le Studio

Les deux applications ne se parlent jamais directement : l'utilisateur exporte un fichier de l'une et l'importe dans l'autre.
Ce document est la référence du format, **version 1**. Chaque appli garde sa propre copie du schéma (zod) et ses tests ;
un changement de format = une nouvelle version, et l'import accepte les versions qu'il connaît.

## Le fichier

Un `.zip` qui contient :
- `echange.json` — l'en-tête et les éléments ;
- `images/…` et `videos/…` — seulement pour les fiches, référencés par leur nom depuis `echange.json`.

```jsonc
{
  "format": "atelier-echange",
  "type": "fiches" | "suivis" | "boutique",
  "version": 1,
  "createdAt": 1793271134054,          // millisecondes
  "from": "studio" | "etsy",
  "items": [ /* fiches/suivis ; boutique utilise commandes et annonces, voir ci-dessous */ ]
}
```

## `fiches` — du Studio vers l'appli Etsy

Chaque fiche devient un **brouillon** Etsy. Le prix est dans la devise lue par le Studio : l'appli Etsy refuse une fiche dont la devise n'est pas celle de la boutique. `whoMade` et `whenMade` manquants : la fiche est refusée à l'import, avec ce qui manque. `ref` est l'identifiant stable de la fiche dans le Studio : réimporter la même `ref`
met à jour le brouillon déjà créé au lieu d'en créer un second (tant qu'il est encore en brouillon).

```jsonc
{
  "ref": "st_8f2c…",                    // identifiant Studio, stable
  "shop": "Nom de la boutique",
  "title": "…", "description": "…",
  "tags": ["…"],                        // 13 au plus, déjà normalisés
  "materials": ["…"],
  "price": { "amount": 24.9, "currency": "EUR" },
  "quantity": 10,
  "whoMade": "i_did" | "someone_else" | "collective" | null,   // choisi par le vendeur, jamais imposé
  "whenMade": "made_to_order" | "2020_2026" | "…" | null,
  "isSupply": false,
  "productionPartner": "Nom du partenaire" | null,        // rattaché au partenaire déclaré sur Etsy, par son nom
  "taxonomyId": 1234 | null,
  "language": "fr",
  "translations": { "en": { "title": "…", "description": "…", "tags": ["…"] } },
  "variations": {                                       // ou null ; seules les combinaisons réellement en vente
    "properties": [ { "name": "Taille", "values": ["S", "M"] } ],
    "combinations": [ { "values": ["S"], "price": 24.9, "sku": "…" | null } ]
  } | null,
  "images": [ { "file": "images/st_8f2c-1.png", "alt": "…" } ],   // dans l'ordre d'affichage
  "video": "videos/st_8f2c.mp4" | null
}
```

## Export de boutique vers le Studio

`GET /api/boutique/export?shop=<uid optionnel>&periode=tout|1m|30j|7j|1j` retourne `boutique.zip`, sans cache.
La valeur par défaut est `30j` ; une valeur inconnue est refusée (400). Sans `shop`, les boutiques archivées sont ignorées.

L'enveloppe `boutique` remplace `items` par deux tableaux `commandes` et `annonces`, avec le champ `periode`.
Les commandes sont payées et non expédiées (sur Etsy et dans le Studio), filtrées sur leur date de paiement.
La date de paiement provient de `transactions[].paid_timestamp` (dernier paiement du reçu). À défaut dans le cache, la date comptable du reçu sert de référence.
`1m` soustrait un mois calendaire en UTC, avec le jour borné au dernier jour du mois ; `30j`, `7j` et `1j` sont des durées glissantes.
Toutes les annonces sont incluses, quelle que soit la période.

Exemple d'enveloppe :

```json
{
  "format": "atelier-echange", "type": "boutique", "version": 1,
  "createdAt": 1793271134054, "from": "etsy", "periode": "30j",
  "commandes": [],
  "annonces": [{
    "shop": "Ma boutique", "listingId": 1234567890, "ref": null,
    "title": "Objet", "state": "active", "image": null,
    "sales": 12, "variations": ["Bleu, S"], "hasVideo": true
  }]
}
```

Les commandes portent shop (nom), receiptId, paidAt (millisecondes), items et shipTo.
Chaque article porte listingId, ref Studio ou null, title, variation, options [{name,value}], sku, quantity, image HTTPS ou null.
shipTo contient toujours country, name, line1, line2, city, state et zip : les adresses sont incluses sans option.
Ce fichier contient des adresses de clients : ne pas le partager. Le Studio les efface après expédition.
Les boutiques sont reliées par leur nom ; une boutique absente est créée par le Studio.

Les annonces portent shop, listingId, ref, title, state, image HTTPS ou null, sales, variations et hasVideo.
hasVideo indique un montage terminé (video_jobs.status = done), dont sources.shop est l'uid de boutique et sources.id l'annonce.
Aucun montage ni autre média n'est inclus dans boutique.zip : uniquement echange.json.
Les deux tableaux vides sont refusés. Plus de ECHANGE_LIMITS.boutique (5000) éléments au total sont refusés sans troncature : choisir une période plus courte ou une seule boutique.
L'export reste accessible sans abonnement ; une boutique d'un autre compte renvoie 404.

## `suivis` — du Studio vers l'appli Etsy

L'état de chaque commande dans le Studio, expédiée ou non.

```jsonc
{
  "shop": "Nom de la boutique", "receiptId": 3456789012,
  "etat": "a_preparer" | "devis_en_cours" | "paiement_attendu" | "paye" | "envoye" | "annule",
  "carrier": "…" | null, "trackingCode": "…" | null, "shippedAt": 1793271134054 | null
}
```
Seul `envoye` compte comme expédiée sur le site Etsy, qui affiche l'état sur sa page Commandes. Le suivi n'est posé sur la commande Etsy que pour une commande `envoye` avec un numéro de suivi, après confirmation ; une commande déjà expédiée avec le même suivi est ignorée.
Le transporteur, le numéro et la date d'envoi importés restent disponibles avant la prochaine synchronisation Etsy, même si l'appel Etsy échoue. Un import ne fait jamais reculer l'état enregistré. La page Commandes privilégie le dernier envoi Etsy, sinon le suivi Studio ; aucune adresse n'est rendue pour une commande envoyée.

## Règles d'import (les deux applis)

Un fichier importé vient de l'extérieur : il est traité comme non fiable.
- Taille bornée (archive 200 Mo, image 20 Mo, vidéo 100 Mo, 500 éléments pour fiches/suivis, 5000 au total pour boutique), pas de chemin qui sort de l'archive, rien d'autre que les fichiers prévus.
- Images et vidéos vérifiées par leur contenu (signature JPEG / PNG / WebP / MP4), pas par leur extension.
- `echange.json` validé strictement (zod) : un champ inconnu ou un type faux refuse le fichier entier, avec un message qui dit lequel.
- L'import montre d'abord ce qu'il va faire (« 12 brouillons à créer, 3 à mettre à jour ») et n'agit qu'après confirmation.
- Aucune clé, aucun jeton, aucun identifiant de compte dans un fichier d'échange.
