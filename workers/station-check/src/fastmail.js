// Send a plain-text email through Fastmail's JMAP API.
// Needs a Fastmail API token with "Email" and "Email submission" access, stored as the secret FASTMAIL_TOKEN.
// The From address must be one of the account's sending identities.
const SESSION_URL = 'https://api.fastmail.com/jmap/session';
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];

export async function sendMail({ token, from, to, replyTo, subject, text }) {
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const sres = await fetch(SESSION_URL, { headers: auth });
  if (!sres.ok) throw new Error(`Fastmail session ${sres.status}`);
  const session = await sres.json();
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:submission'] || session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const call = async (methodCalls) => {
    const r = await fetch(session.apiUrl, { method: 'POST', headers: auth, body: JSON.stringify({ using: USING, methodCalls }) });
    if (!r.ok) throw new Error(`Fastmail API ${r.status}`);
    return (await r.json()).methodResponses;
  };

  const [[, ids], [, boxes]] = await call([
    ['Identity/get', { accountId }, 'i'],
    ['Mailbox/query', { accountId, filter: { role: 'drafts' } }, 'm'],
  ]);
  const identity = ids.list.find((x) => x.email.toLowerCase() === from.toLowerCase()) || ids.list[0];
  const drafts = boxes.ids[0];
  if (!identity || !drafts) throw new Error('Fastmail: no sending identity or drafts mailbox');

  const res = await call([
    ['Email/set', { accountId, create: { msg: {
      mailboxIds: { [drafts]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ name: 'EV Trip Reports', email: identity.email }],
      to: [{ email: to }],
      ...(replyTo ? { replyTo: [{ email: replyTo }] } : {}),
      subject,
      bodyValues: { body: { value: text } },
      textBody: [{ partId: 'body', type: 'text/plain' }],
    } } }, 'e'],
    ['EmailSubmission/set', { accountId, create: { sub: { emailId: '#msg', identityId: identity.id } }, onSuccessDestroyEmail: ['#sub'] }, 's'],
  ]);
  const sub = res.find(([name]) => name === 'EmailSubmission/set');
  if (!sub || !sub[1].created || !sub[1].created.sub) {
    throw new Error(`Fastmail send failed: ${JSON.stringify(res).slice(0, 300)}`);
  }
}
