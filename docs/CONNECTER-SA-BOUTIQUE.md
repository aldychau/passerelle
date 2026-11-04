# Connecter ta boutique Etsy

Tu utilises ta propre application Etsy sur ton PC. L’approbation, les accès et les limites dépendent d’Etsy ; aucun délai n’est garanti.

1. **Crée ton application.** Connecte-toi avec ton compte vendeur sur [Etsy Developers](https://www.etsy.com/developers), puis ouvre [Your Apps](https://www.etsy.com/developers/your-apps). Choisis « Create a New App ». Donne un nom et décris ton usage personnel : extraire ta boutique et gérer tes brouillons. Remplis les informations demandées et accepte les conditions Etsy. Suis les indications d’Etsy pour l’approbation.
2. **Ajoute l’adresse de rappel.** Dans les réglages de cette application, enregistre exactement cette adresse, sans barre oblique supplémentaire :

   `http://127.0.0.1:3030/oauth/etsy/callback`

3. **Colle tes clés dans Passerelle.** Lance Passerelle puis ouvre **Boutiques**. Donne à ta boutique le même nom que dans le Studio. Copie la **Keystring** et le **Shared Secret** depuis Etsy dans les champs correspondants. Clique sur **Ajouter la boutique**. Garde ces clés privées : ne les colle jamais dans GitHub ou une capture d’écran.
4. **Autorise la connexion.** Clique sur **Connecter à Etsy**. Vérifie le compte Etsy affiché, puis autorise les accès demandés sur la page officielle. Tu reviens dans Passerelle. Avant d’importer des fiches physiques, choisis tes profils avec **Profils des brouillons**. Passerelle crée ou modifie seulement des brouillons, sans publication.
5. **Ajoute une deuxième boutique.** Réutilise la même application, la même Keystring et le même Shared Secret. Ajoute la deuxième boutique sous son propre nom dans Passerelle. Pour éviter de reprendre le premier compte, ouvre `http://127.0.0.1:3030` dans une fenêtre privée, connecte-toi à Etsy avec le compte de la deuxième boutique et lance sa connexion depuis Passerelle dans cette fenêtre. Vérifie le compte avant d’autoriser. Répète pour chaque boutique autorisée par Etsy.

Si Etsy refuse la connexion, vérifie les clés, l’adresse de rappel exacte, le compte utilisé et l’état d’approbation de ton application. Déconnecter dans Passerelle efface les jetons locaux ; pour retirer l’autorisation distante, révoque aussi l’application dans Etsy.
