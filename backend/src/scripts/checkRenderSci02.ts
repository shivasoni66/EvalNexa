// Native fetch used

async function run() {
  const loginRes = await fetch('https://evalnexa.onrender.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@evalnexa.edu', password: 'Admin@1234' }),
  });
  const loginData: any = await loginRes.json();
  const token = loginData?.data?.token;
  console.log('Admin Login:', loginData?.success ? 'SUCCESS' : 'FAILED');

  const evalRes = await fetch('https://evalnexa.onrender.com/api/evaluations/6ac534cd75a10db981adc07e', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const evalData: any = await evalRes.json();
  console.log('Evaluation status:', evalData?.data?.status);
  console.log('Total marks:', evalData?.data?.totalMarks);
  console.log('Total possible marks:', evalData?.data?.totalPossibleMarks);
  console.log('Question marks length:', evalData?.data?.questionMarks?.length);

  const q7 = evalData?.data?.questionMarks?.find((q: any) => q.questionNumber === 7 || q.questionId === '7');
  console.log('Q7 details:', q7);

  const modRes = await fetch('https://evalnexa.onrender.com/api/moderation/6ac534cd75a10db981adc07e', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const modData: any = await modRes.json();
  console.log('Moderation endpoint status:', modRes.status);
  console.log('Moderation data status:', modData?.data?.status);
}

run().catch(console.error);
