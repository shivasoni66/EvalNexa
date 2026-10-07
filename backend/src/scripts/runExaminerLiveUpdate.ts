async function run() {
  console.log('1. Logging in as Examiner...');
  const loginRes = await fetch('https://evalnexa.onrender.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'examiner@evalnexa.edu', password: 'Examiner@5678' }),
  });
  const loginData: any = await loginRes.json();
  const token = loginData?.data?.token;
  if (!token) {
    console.error('Failed to get examiner token:', loginData);
    process.exit(1);
  }
  console.log('Examiner logged in successfully.');

  const evalId = '6ac534cd75a10db981adc07e';

  // 2. Check current status
  const currentRes = await fetch(`https://evalnexa.onrender.com/api/evaluations/${evalId}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const currentData: any = await currentRes.json();
  console.log('Current evaluation status:', currentData?.data?.status);
  console.log('Current total marks:', currentData?.data?.totalMarks);

  // If status is RETURNED, call start to re-open
  if (currentData?.data?.status === 'RETURNED') {
    console.log('Re-opening evaluation from RETURNED to IN_PROGRESS...');
    const startRes = await fetch(`https://evalnexa.onrender.com/api/evaluations/${evalId}/start`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    });
    const startData: any = await startRes.json();
    console.log('Start result:', startData?.success ? 'SUCCESS' : startData?.message);
  }

  // 3. Prepare updated questionMarks list with Q7 = 3
  const questionMarks = currentData?.data?.questionMarks || [];
  const updatedQm = questionMarks.map((qm: any) => {
    if (qm.questionNumber === 7) {
      return {
        ...qm,
        marks: 3,
        status: 'MARKED',
        examinerReviewed: true,
      };
    }
    return {
      ...qm,
      examinerReviewed: true,
    };
  });

  console.log('3. Updating Q7 marks to 3/5 via PATCH /api/evaluations/:id...');
  const patchRes = await fetch(`https://evalnexa.onrender.com/api/evaluations/${evalId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({
      questionMarks: updatedQm,
      remarks: 'Revised Q7 score to 3/5 based on moderation feedback',
    }),
  });

  const patchData: any = await patchRes.json();
  console.log('PATCH response status:', patchRes.status);
  console.log('PATCH success:', patchData?.success);
  console.log('New total marks in DB:', patchData?.data?.totalMarks);
  const q7New = patchData?.data?.questionMarks?.find((q: any) => q.questionNumber === 7);
  console.log('New Q7 marks:', q7New?.marks);
}

run().catch(console.error);
