import { getUser, json, noContent, notFound, pathParam } from '../../lib/http';
import { createRouter } from '../../lib/router';
import { deleteConversation, getConversation, listConversations, loadMessages } from '../../repo/chats';

export const handler = createRouter({
  'GET /chat/conversations': async (event) => {
    const user = getUser(event);
    return json(200, { items: await listConversations(user.sub) });
  },

  'GET /chat/conversations/{id}': async (event) => {
    const user = getUser(event);
    const id = pathParam(event, 'id');
    const conversation = await getConversation(user.sub, id);
    if (!conversation) throw notFound('Conversation not found');
    return json(200, { conversation, messages: await loadMessages(user.sub, id) });
  },

  'DELETE /chat/conversations/{id}': async (event) => {
    const user = getUser(event);
    await deleteConversation(user.sub, pathParam(event, 'id'));
    return noContent();
  },
});
