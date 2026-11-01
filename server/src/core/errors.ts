export const badRequest = (message = 'Requête invalide.') => Object.assign(new Error(message), {statusCode:400});
