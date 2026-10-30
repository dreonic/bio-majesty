import { json, noContent, notFound, pathParam } from '../../lib/http';
import { createProfileRouter } from '../../lib/router';
import { deleteConversation, getConversation, listConversations, loadMessages } from '../../repo/chats';

export const handler = createProfileRouter({
  'GET /chat/conversations': async (_event, user) => json(200, { items: await listConversations(user.profileId) }),

  'GET /chat/conversations/{id}': async (event, user) => {
    const id = pathParam(event, 'id');
    const conversation = await getConversation(user.profileId, id);
    if (!conversation) throw notFound('Conversation not found');
    return json(200, { conversation, messages: await loadMessages(user.profileId, id) });
  },

  'DELETE /chat/conversations/{id}': async (event, user) => {
    await deleteConversation(user.profileId, pathParam(event, 'id'));
    return noContent();
  },
});
