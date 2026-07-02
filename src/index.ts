import { getValidatorInflatioinReward, setValidatorInfo, writeValidatorStats } from "./firedancerScripts/infor.ts"

import { getValidatorInfo } from "./jitoScripts/fetchValidators.ts"

(async () => {
    await getValidatorInfo()
})()